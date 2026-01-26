import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister, unregisterAll } from "@tauri-apps/plugin-global-shortcut";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { APP_VERSION } from "./version";
import appIcon from "./assets/icon.png";
import "./App.css";

type View = "main" | "settings" | "history";
type ApiKeyStatus = "idle" | "validating" | "valid" | "invalid";
type HistoryLimit = 10 | 25 | 50 | 0; // 0 = unlimited
type STTProvider = "gemini" | "openai" | "mistral";
interface HistoryItem {
  id: string;
  text: string;
  timestamp: number;
}

interface STTModel {
  id: string;
  name: string;
}

interface ProviderConfig {
  apiKey: string;
  apiKeyStatus: ApiKeyStatus;
  selectedModel: string;
  availableModels: STTModel[];
  isLoadingModels: boolean;
}

const DEFAULT_MODELS: Record<STTProvider, STTModel[]> = {
  gemini: [
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  openai: [
    { id: "whisper-1", name: "Whisper" },
    { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe" },
    { id: "gpt-4o-mini-transcribe", name: "GPT-4o Mini Transcribe" },
  ],
  mistral: [
    { id: "voxtral-mini-latest", name: "Voxtral Mini (3B)" },
    { id: "voxtral-small-latest", name: "Voxtral Small (24B)" },
  ],
};

const PROVIDER_NAMES: Record<STTProvider, string> = {
  gemini: "Google Gemini",
  openai: "OpenAI",
  mistral: "Mistral AI",
};

function App() {
  const [view, setView] = useState<View>("main");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribedText, setTranscribedText] = useState("");
  const [copied, setCopied] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);

  // STT Provider state
  const [selectedProvider, setSelectedProvider] = useState<STTProvider>(() => {
    return (localStorage.getItem("stt_provider") as STTProvider) || "gemini";
  });
  const [sttExpanded, setSttExpanded] = useState(true);
  const [providerConfigs, setProviderConfigs] = useState<Record<STTProvider, ProviderConfig>>(() => {
    const saved = localStorage.getItem("provider_configs");
    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults to ensure all providers exist
      return {
        gemini: { ...getDefaultConfig("gemini"), ...parsed.gemini },
        openai: { ...getDefaultConfig("openai"), ...parsed.openai },
        mistral: { ...getDefaultConfig("mistral"), ...parsed.mistral },
      };
    }
    return {
      gemini: getDefaultConfig("gemini"),
      openai: getDefaultConfig("openai"),
      mistral: getDefaultConfig("mistral"),
    };
  });

  function getDefaultConfig(provider: STTProvider): ProviderConfig {
    // Try to migrate old API key for Gemini
    const oldApiKey = provider === "gemini" ? localStorage.getItem("google_api_key") || "" : "";
    return {
      apiKey: oldApiKey,
      apiKeyStatus: oldApiKey ? "idle" : "idle",
      selectedModel: DEFAULT_MODELS[provider][0].id,
      availableModels: DEFAULT_MODELS[provider],
      isLoadingModels: false,
    };
  }

  // Convenience accessors for current provider
  const currentConfig = providerConfigs[selectedProvider];
  const apiKey = currentConfig.apiKey;

  // History state
  const [historyEnabled, setHistoryEnabled] = useState(() => {
    const saved = localStorage.getItem("history_enabled");
    return saved !== null ? saved === "true" : true; // Default: enabled
  });
  const [historyLimit, setHistoryLimit] = useState<HistoryLimit>(() => {
    const saved = localStorage.getItem("history_limit");
    return saved !== null ? (parseInt(saved) as HistoryLimit) : 25; // Default: 25
  });
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem("transcript_history");
    return saved ? JSON.parse(saved) : [];
  });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const validationTimeoutRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorPositionRef = useRef<number>(0);

  // Refs to access current state in hotkey callback
  const isRecordingRef = useRef(isRecording);
  const apiKeyRef = useRef(apiKey);
  const isTranscribingRef = useRef(isTranscribing);
  const transcribedTextRef = useRef(transcribedText);
  const selectedProviderRef = useRef(selectedProvider);
  const currentConfigRef = useRef(currentConfig);
  const lastHotkeyTimeRef = useRef(0); // Cooldown to prevent double-triggers

  // Keep refs in sync with state
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { apiKeyRef.current = apiKey; }, [apiKey]);
  useEffect(() => { isTranscribingRef.current = isTranscribing; }, [isTranscribing]);
  useEffect(() => { transcribedTextRef.current = transcribedText; }, [transcribedText]);
  useEffect(() => { selectedProviderRef.current = selectedProvider; }, [selectedProvider]);
  useEffect(() => { currentConfigRef.current = currentConfig; }, [currentConfig]);

  // Validate API key on mount if one exists
  useEffect(() => {
    if (currentConfig.apiKey) {
      validateProviderApiKey(selectedProvider, currentConfig.apiKey);
    }
  }, []);

  // Check autostart status on mount
  useEffect(() => {
    isEnabled().then(setAutostartEnabled).catch(console.error);
  }, []);

  // Toggle autostart
  const toggleAutostart = async () => {
    try {
      if (autostartEnabled) {
        await disable();
        setAutostartEnabled(false);
      } else {
        await enable();
        setAutostartEnabled(true);
      }
    } catch (err) {
      console.error("Failed to toggle autostart:", err);
    }
  };

  // History management
  const saveToHistory = useCallback((text: string) => {
    if (!historyEnabled || !text || text.length < 5) return;
    // Don't save error messages
    if (text.startsWith("Fehler") || text.startsWith("Bitte") || text.startsWith("API") ||
        text.startsWith("Keine") || text.startsWith("Mikrofon") || text.startsWith("Verbindung")) return;

    const newItem: HistoryItem = {
      id: Date.now().toString(),
      text: text,
      timestamp: Date.now()
    };

    setHistory(prev => {
      // Check if the same text already exists (avoid duplicates)
      if (prev.length > 0 && prev[0].text === text) return prev;

      let newHistory = [newItem, ...prev];
      // Apply limit (0 = unlimited)
      if (historyLimit > 0) {
        newHistory = newHistory.slice(0, historyLimit);
      }
      localStorage.setItem("transcript_history", JSON.stringify(newHistory));
      return newHistory;
    });
  }, [historyEnabled, historyLimit]);

  const deleteHistoryItem = useCallback((id: string) => {
    setHistory(prev => {
      const newHistory = prev.filter(item => item.id !== id);
      localStorage.setItem("transcript_history", JSON.stringify(newHistory));
      return newHistory;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    localStorage.removeItem("transcript_history");
  }, []);

  const restoreFromHistory = useCallback((text: string) => {
    setTranscribedText(text);
    setView("main");
  }, []);

  const toggleHistoryEnabled = useCallback((enabled: boolean) => {
    setHistoryEnabled(enabled);
    localStorage.setItem("history_enabled", enabled.toString());
  }, []);

  const updateHistoryLimit = useCallback((limit: HistoryLimit) => {
    setHistoryLimit(limit);
    localStorage.setItem("history_limit", limit.toString());
    // Trim existing history if needed
    if (limit > 0) {
      setHistory(prev => {
        const trimmed = prev.slice(0, limit);
        localStorage.setItem("transcript_history", JSON.stringify(trimmed));
        return trimmed;
      });
    }
  }, []);

  // Provider config management
  const updateProviderConfig = useCallback((provider: STTProvider, updates: Partial<ProviderConfig>) => {
    setProviderConfigs(prev => {
      const newConfigs = {
        ...prev,
        [provider]: { ...prev[provider], ...updates }
      };
      localStorage.setItem("provider_configs", JSON.stringify(newConfigs));
      return newConfigs;
    });
  }, []);

  const selectProvider = useCallback((provider: STTProvider) => {
    setSelectedProvider(provider);
    localStorage.setItem("stt_provider", provider);
  }, []);

  // Fetch models for a provider
  const fetchModelsForProvider = useCallback(async (provider: STTProvider) => {
    const config = providerConfigs[provider];
    if (!config.apiKey || config.apiKey.length < 10) return;

    updateProviderConfig(provider, { isLoadingModels: true });

    try {
      let models: STTModel[] = DEFAULT_MODELS[provider];

      if (provider === "gemini") {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${config.apiKey}`
        );
        if (response.ok) {
          const data = await response.json();
          const audioModels = data.models?.filter((m: { name: string; supportedGenerationMethods?: string[] }) =>
            m.supportedGenerationMethods?.includes("generateContent") &&
            (m.name.includes("flash") || m.name.includes("pro"))
          ) || [];
          if (audioModels.length > 0) {
            models = audioModels.map((m: { name: string; displayName?: string }) => ({
              id: m.name.replace("models/", ""),
              name: m.displayName || m.name.replace("models/", ""),
            }));
          }
        }
      } else if (provider === "openai") {
        // OpenAI doesn't have a models list endpoint for audio, use static list
        models = [
          { id: "whisper-1", name: "Whisper" },
          { id: "gpt-4o-transcribe", name: "GPT-4o Transcribe" },
          { id: "gpt-4o-mini-transcribe", name: "GPT-4o Mini Transcribe" },
          { id: "gpt-4o-transcribe-diarize", name: "GPT-4o Diarize (Speaker)" },
        ];
      } else if (provider === "mistral") {
        // Mistral audio models - Voxtral family
        models = [
          { id: "voxtral-mini-latest", name: "Voxtral Mini (3B)" },
          { id: "voxtral-small-latest", name: "Voxtral Small (24B)" },
        ];
      }

      updateProviderConfig(provider, {
        availableModels: models,
        isLoadingModels: false,
        apiKeyStatus: "valid"
      });
    } catch (err) {
      console.error(`Failed to fetch models for ${provider}:`, err);
      updateProviderConfig(provider, { isLoadingModels: false });
    }
  }, [providerConfigs, updateProviderConfig]);

  // Validate API key for provider
  const validateProviderApiKey = useCallback(async (provider: STTProvider, key: string) => {
    if (!key || key.length < 10) {
      updateProviderConfig(provider, { apiKeyStatus: "idle" });
      return;
    }

    updateProviderConfig(provider, { apiKeyStatus: "validating" });

    try {
      let isValid = false;

      if (provider === "gemini") {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
        );
        isValid = response.ok;
      } else if (provider === "openai") {
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` }
        });
        isValid = response.ok;
      } else if (provider === "mistral") {
        const response = await fetch("https://api.mistral.ai/v1/models", {
          headers: { Authorization: `Bearer ${key}` }
        });
        isValid = response.ok;
      }

      updateProviderConfig(provider, { apiKeyStatus: isValid ? "valid" : "invalid" });

      if (isValid) {
        fetchModelsForProvider(provider);
      }
    } catch {
      updateProviderConfig(provider, { apiKeyStatus: "invalid" });
    }
  }, [updateProviderConfig, fetchModelsForProvider]);

  // Register global hotkey Ctrl+Y (only once, use refs for current state)
  useEffect(() => {
    const HOTKEY = "ctrl+y";
    const COOLDOWN_MS = 300; // Prevent double-triggers

    const setupHotkey = async () => {
      try {
        // First unregister ALL hotkeys to clear any lingering registrations
        try {
          await unregisterAll();
          console.log("Cleared all previous hotkey registrations");
        } catch {
          // Ignore errors
        }

        console.log("Registering hotkey:", HOTKEY);
        await register(HOTKEY, async () => {
          console.log("Hotkey triggered!");
          // Cooldown check to prevent rapid double-triggers
          const now = Date.now();
          if (now - lastHotkeyTimeRef.current < COOLDOWN_MS) {
            console.log("Hotkey cooldown - ignoring");
            return;
          }
          lastHotkeyTimeRef.current = now;

          // Show window first
          const win = getCurrentWindow();
          await win.show();
          await win.setFocus();

          // Use refs to get current state values
          const currentIsRecording = isRecordingRef.current;
          const currentApiKey = apiKeyRef.current;
          const currentIsTranscribing = isTranscribingRef.current;
          const currentTranscribedText = transcribedTextRef.current;

          // Toggle recording
          if (currentIsRecording) {
            if (mediaRecorderRef.current) {
              mediaRecorderRef.current.stop();
              setIsRecording(false);
            }
          } else if (currentApiKey && !currentIsTranscribing) {
            // Start recording - use the unified startRecording function via button click simulation
            // For hotkey, we use batch mode directly to avoid async issues
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
              mediaRecorderRef.current = mediaRecorder;
              chunksRef.current = [];

              // Save cursor position
              if (textareaRef.current) {
                cursorPositionRef.current = textareaRef.current.selectionStart ?? currentTranscribedText.length;
              } else {
                cursorPositionRef.current = currentTranscribedText.length;
              }

              mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                  chunksRef.current.push(e.data);
                }
              };

              mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
                stream.getTracks().forEach((track) => track.stop());
                await transcribeAudioFromHotkey(audioBlob);
              };

              mediaRecorder.start();
              setIsRecording(true);
            } catch (err) {
              console.error("Microphone error:", err);
            }
          }
        });
      } catch (err) {
        // Ignore "already registered" errors - hotkey still works
        console.log("Hotkey registration note:", err);
      }
    };

    setupHotkey();

    return () => {
      unregister(HOTKEY).catch(console.error);
    };
  }, []); // Empty dependencies - register only once

  // Save API key for a provider with debounced validation
  const saveProviderApiKey = useCallback((provider: STTProvider, key: string) => {
    updateProviderConfig(provider, { apiKey: key });

    // Debounce validation
    if (validationTimeoutRef.current) {
      clearTimeout(validationTimeoutRef.current);
    }
    validationTimeoutRef.current = window.setTimeout(() => {
      validateProviderApiKey(provider, key);
    }, 500);
  }, [updateProviderConfig, validateProviderApiKey]);

  const startRecording = useCallback(async () => {
    if (!apiKey) {
      setTranscribedText("Bitte API Key in den Settings hinterlegen");
      return;
    }

    // Save cursor position before recording
    if (textareaRef.current) {
      cursorPositionRef.current = textareaRef.current.selectionStart ?? transcribedText.length;
    } else {
      cursorPositionRef.current = transcribedText.length;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        await transcribeAudio(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setTranscribedText("Mikrofon-Zugriff verweigert. Bitte Berechtigung erteilen.");
    }
  }, [apiKey, transcribedText]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  const insertTextAtCursor = useCallback((newText: string) => {
    const pos = cursorPositionRef.current;
    const before = transcribedText.slice(0, pos);
    const after = transcribedText.slice(pos);
    // Add space before if there's text before and it doesn't end with space/newline
    const needsSpaceBefore = before.length > 0 && !/[\s\n]$/.test(before);
    const separator = needsSpaceBefore ? " " : "";
    const updatedText = before + separator + newText + after;
    setTranscribedText(updatedText);

    // Update cursor position to end of inserted text
    const newCursorPos = pos + separator.length + newText.length;
    cursorPositionRef.current = newCursorPos;

    // Set cursor position in textarea after state update and scroll to cursor
    setTimeout(() => {
      if (textareaRef.current) {
        const textarea = textareaRef.current;
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);

        // Scroll to cursor position
        // Create a temporary span to measure text height up to cursor
        const textBeforeCursor = updatedText.substring(0, newCursorPos);
        const lines = textBeforeCursor.split('\n').length;
        const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
        const scrollTarget = Math.max(0, (lines - 2) * lineHeight);
        textarea.scrollTop = scrollTarget;
      }
    }, 0);
  }, [transcribedText]);

  // Multi-provider transcription
  const transcribeWithProvider = async (
    audioBlob: Blob,
    provider: STTProvider,
    config: ProviderConfig
  ): Promise<string> => {
    const base64Audio = await blobToBase64(audioBlob);

    if (provider === "gemini") {
      const model = config.selectedModel || "gemini-2.0-flash";
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  text: "Transkribiere diese Audioaufnahme exakt. Gib NUR den transkribierten Text zurück, ohne zusätzliche Kommentare, Erklärungen oder Formatierung. Wenn du keine Sprache erkennst, antworte mit: [KEINE SPRACHE ERKANNT]"
                },
                {
                  inlineData: {
                    mimeType: "audio/webm",
                    data: base64Audio
                  }
                }
              ]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8192
            }
          }),
        }
      );

      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      } else if (data.error) {
        throw new Error(data.error.message || "Gemini API Error");
      }
      throw new Error("Keine Antwort von Gemini");

    } else if (provider === "openai") {
      // Convert base64 to blob for FormData
      const audioBuffer = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
      const audioFile = new Blob([audioBuffer], { type: "audio/webm" });

      const formData = new FormData();
      formData.append("file", audioFile, "audio.webm");
      formData.append("model", config.selectedModel || "whisper-1");
      formData.append("language", "de");

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: formData,
      });

      const data = await response.json();
      if (data.text) {
        return data.text;
      } else if (data.error) {
        throw new Error(data.error.message || "OpenAI API Error");
      }
      throw new Error("Keine Antwort von OpenAI");

    } else if (provider === "mistral") {
      // Convert base64 to blob for FormData
      const audioBuffer = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
      const audioFile = new Blob([audioBuffer], { type: "audio/webm" });

      const formData = new FormData();
      formData.append("file", audioFile, "audio.webm");
      formData.append("model", config.selectedModel || "voxtral-mini-latest");

      const response = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: formData,
      });

      const data = await response.json();
      if (data.text) {
        return data.text;
      } else if (data.error) {
        throw new Error(data.error.message || "Mistral API Error");
      }
      throw new Error("Keine Antwort von Mistral");
    }

    throw new Error("Unbekannter Provider");
  };

  const transcribeAudio = async (audioBlob: Blob) => {
    if (!apiKey) {
      setTranscribedText("Bitte API Key in den Settings hinterlegen");
      return;
    }

    setIsTranscribing(true);

    try {
      const transcript = await transcribeWithProvider(audioBlob, selectedProvider, currentConfig);

      if (transcript === "[KEINE SPRACHE ERKANNT]" || transcript.includes("[KEINE SPRACHE ERKANNT]")) {
        if (!transcribedText) {
          setTranscribedText("Keine Sprache erkannt. Bitte erneut versuchen.");
        }
      } else {
        insertTextAtCursor(transcript.trim());
      }
    } catch (err) {
      console.error("Transcription error:", err);
      const errorMsg = err instanceof Error ? err.message : "Unbekannter Fehler";
      if (errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("invalid")) {
        setTranscribedText("API Key ungültig");
        updateProviderConfig(selectedProvider, { apiKeyStatus: "invalid" });
      } else {
        setTranscribedText(`Fehler: ${errorMsg}`);
      }
    } finally {
      setIsTranscribing(false);
    }
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Transcribe function for hotkey that uses refs for current state
  const transcribeAudioFromHotkey = async (audioBlob: Blob) => {
    const currentApiKey = apiKeyRef.current;
    const provider = selectedProviderRef.current;
    const config = currentConfigRef.current;

    if (!currentApiKey) {
      setTranscribedText("Bitte API Key in den Settings hinterlegen");
      return;
    }

    setIsTranscribing(true);

    try {
      // Use refs to get current provider and config
      const transcript = await transcribeWithProvider(audioBlob, provider, {
        ...config,
        apiKey: currentApiKey
      });

      if (transcript === "[KEINE SPRACHE ERKANNT]" || transcript.includes("[KEINE SPRACHE ERKANNT]")) {
        const currentText = transcribedTextRef.current;
        if (!currentText) {
          setTranscribedText("Keine Sprache erkannt. Bitte erneut versuchen.");
        }
      } else {
        // Insert at cursor using refs
        const pos = cursorPositionRef.current;
        const currentText = transcribedTextRef.current;
        const before = currentText.slice(0, pos);
        const after = currentText.slice(pos);
        const needsSpaceBefore = before.length > 0 && !/[\s\n]$/.test(before);
        const separator = needsSpaceBefore ? " " : "";
        const trimmedTranscript = transcript.trim();
        const updatedText = before + separator + trimmedTranscript + after;
        setTranscribedText(updatedText);

        const newCursorPos = pos + separator.length + trimmedTranscript.length;
        cursorPositionRef.current = newCursorPos;

        // Set cursor position and scroll to it
        setTimeout(() => {
          if (textareaRef.current) {
            const textarea = textareaRef.current;
            textarea.focus();
            textarea.setSelectionRange(newCursorPos, newCursorPos);

            // Scroll to cursor position
            const textBeforeCursor = updatedText.substring(0, newCursorPos);
            const lines = textBeforeCursor.split('\n').length;
            const lineHeight = parseInt(getComputedStyle(textarea).lineHeight) || 20;
            const scrollTarget = Math.max(0, (lines - 2) * lineHeight);
            textarea.scrollTop = scrollTarget;
          }
        }, 0);
      }
    } catch (err) {
      console.error("Transcription error:", err);
      const errorMsg = err instanceof Error ? err.message : "Unbekannter Fehler";
      if (errorMsg.includes("401") || errorMsg.includes("403") || errorMsg.includes("invalid")) {
        setTranscribedText("API Key ungültig");
        updateProviderConfig(provider, { apiKeyStatus: "invalid" });
      } else {
        setTranscribedText(`Fehler: ${errorMsg}`);
      }
    } finally {
      setIsTranscribing(false);
    }
  };

  const copyToClipboard = useCallback(async () => {
    if (transcribedText && !transcribedText.startsWith("Fehler") && !transcribedText.startsWith("Bitte") && !transcribedText.startsWith("API") && !transcribedText.startsWith("Keine") && !transcribedText.startsWith("Mikrofon") && !transcribedText.startsWith("Verbindung")) {
      await navigator.clipboard.writeText(transcribedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [transcribedText]);

  return (
    <div className="h-full bg-gradient-dark flex flex-col">
      {/* Title bar / drag region */}
      <div className="drag-region h-8 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <img src={appIcon} alt="Voice Typing" className="w-4 h-4" />
          <span className="text-xs text-text-secondary font-medium tracking-wide">
            VOICE TYPING
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView(view === "history" ? "main" : "history")}
            className="no-drag p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            title="Verlauf"
          >
            <HistoryIcon active={view === "history"} />
          </button>
          <button
            onClick={() => setView(view === "settings" ? "main" : "settings")}
            className="no-drag p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            title="Einstellungen"
          >
            <SettingsIcon active={view === "settings"} />
          </button>
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="no-drag p-1.5 rounded-lg hover:bg-white/5 transition-colors"
            title="Minimieren"
          >
            <MinimizeIcon />
          </button>
          <button
            onClick={() => getCurrentWindow().hide()}
            className="no-drag p-1.5 rounded-lg hover:bg-red-500/20 hover:text-red-400 transition-colors"
            title="In Tray minimieren"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center px-6 pb-6 overflow-hidden">
        <AnimatePresence mode="wait">
          {view === "main" ? (
            <motion.div
              key="main"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="w-full max-w-md flex-1 flex flex-col items-center gap-4 overflow-hidden"
            >
              {/* Record Button */}
              <div className="relative shrink-0">
                {isRecording && (
                  <motion.div
                    className="absolute inset-0 rounded-full bg-recording animate-pulse-ring"
                    initial={{ scale: 1, opacity: 0.8 }}
                  />
                )}
                <motion.button
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={isTranscribing}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className={`relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 disabled:opacity-50 ${
                    isRecording
                      ? "bg-recording glow-recording"
                      : isTranscribing
                      ? "bg-yellow-500"
                      : "bg-accent glow-accent hover:brightness-110"
                  }`}
                >
                  {isTranscribing ? (
                    <LoadingIcon />
                  ) : (
                    <MicIcon recording={isRecording} />
                  )}
                </motion.button>
              </div>

              <p className="text-text-secondary text-sm text-center shrink-0">
                {isTranscribing
                  ? "Transkribiere..."
                  : isRecording
                  ? "Aufnahme läuft... Klicken oder Ctrl+Y zum Stoppen"
                  : "Klicken oder Ctrl+Y zum Aufnehmen"}
              </p>

              {/* Text area - grows to fill space */}
              <div className="w-full flex-1 flex flex-col min-h-0">
                <div className="glass rounded-2xl p-4 flex-1 flex flex-col min-h-0">
                  <textarea
                    ref={textareaRef}
                    value={transcribedText}
                    onChange={(e) => setTranscribedText(e.target.value)}
                    placeholder="Transkribierter Text erscheint hier..."
                    className="w-full flex-1 bg-transparent resize-none outline-none text-text-primary placeholder:text-text-secondary/50"
                  />
                </div>

                {/* Action buttons - always at bottom */}
                <div className="flex gap-3 mt-4 shrink-0">
                  <motion.button
                    onClick={copyToClipboard}
                    disabled={!transcribedText || transcribedText.startsWith("Fehler") || transcribedText.startsWith("Bitte") || transcribedText.startsWith("API") || transcribedText.startsWith("Keine") || transcribedText.startsWith("Mikrofon") || transcribedText.startsWith("Verbindung")}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="flex-1 py-3 px-4 rounded-xl glass text-sm font-medium flex items-center justify-center gap-2 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {copied ? (
                      <>
                        <CheckIcon /> Kopiert!
                      </>
                    ) : (
                      <>
                        <CopyIcon /> Kopieren
                      </>
                    )}
                  </motion.button>
                  <motion.button
                    onClick={() => {
                      saveToHistory(transcribedText);
                      setTranscribedText("");
                    }}
                    disabled={!transcribedText}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="py-3 px-4 rounded-xl glass text-sm font-medium hover:bg-white/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <TrashIcon />
                  </motion.button>
                </div>
              </div>
            </motion.div>
          ) : view === "settings" ? (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="w-full max-w-md flex-1 overflow-y-auto pr-1"
            >
              {/* App Header / About */}
              <div className="glass rounded-2xl p-5 mb-4">
                <div className="flex items-center gap-4">
                  <img src={appIcon} alt="Voice Typing" className="w-16 h-16 rounded-xl" />
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold">Voice Typing</h2>
                    <p className="text-xs text-text-secondary font-mono mt-1">v{APP_VERSION}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <a
                        href="https://github.com/AndreasKalkusinski"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent hover:underline"
                      >
                        @AndreasKalkusinski
                      </a>
                      <span className="text-text-secondary/50">·</span>
                      <a
                        href="mailto:it@jeantools.de"
                        className="text-xs text-text-secondary hover:text-accent transition-colors"
                      >
                        it@jeantools.de
                      </a>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-white/10 text-xs text-text-secondary/70 text-center">
                  Sprich. Tippe nicht.
                </div>
              </div>

              {/* Autostart Section */}
              <div className="glass rounded-2xl p-5 mb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium">Autostart</h3>
                    <p className="text-xs text-text-secondary mt-1">
                      App beim Windows-Start automatisch starten
                    </p>
                  </div>
                  <button
                    onClick={toggleAutostart}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      autostartEnabled ? "bg-accent" : "bg-white/10"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                        autostartEnabled ? "translate-x-6" : ""
                      }`}
                    />
                  </button>
                </div>
                <p className="text-xs text-text-secondary/70 mt-3">
                  Startet im Hintergrund - nutze Ctrl+Y zum Aktivieren
                </p>
              </div>

              {/* History Section */}
              <div className="glass rounded-2xl p-5 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-sm font-medium">Verlauf</h3>
                    <p className="text-xs text-text-secondary mt-1">
                      Transkripte automatisch speichern
                    </p>
                  </div>
                  <button
                    onClick={() => toggleHistoryEnabled(!historyEnabled)}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      historyEnabled ? "bg-accent" : "bg-white/10"
                    }`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${
                        historyEnabled ? "translate-x-6" : ""
                      }`}
                    />
                  </button>
                </div>
                {historyEnabled && (
                  <div className="flex gap-2 mt-3">
                    {([10, 25, 50, 0] as HistoryLimit[]).map((limit) => (
                      <button
                        key={limit}
                        onClick={() => updateHistoryLimit(limit)}
                        className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
                          historyLimit === limit
                            ? "bg-accent text-white"
                            : "bg-white/5 text-text-secondary hover:bg-white/10"
                        }`}
                      >
                        {limit === 0 ? "Alle" : limit}
                      </button>
                    ))}
                  </div>
                )}
                <p className="text-xs text-text-secondary/70 mt-3">
                  {history.length} Einträge gespeichert
                </p>
              </div>

              {/* STT Provider Section */}
              <div className="glass rounded-2xl p-5">
                <button
                  onClick={() => {
                    setSttExpanded(!sttExpanded);
                    if (!sttExpanded && currentConfig.apiKey) {
                      fetchModelsForProvider(selectedProvider);
                    }
                  }}
                  className="w-full flex items-center justify-between"
                >
                  <div>
                    <h3 className="text-sm font-medium text-left">Transkription</h3>
                    <p className="text-xs text-text-secondary mt-1 text-left">
                      {PROVIDER_NAMES[selectedProvider]} · {currentConfig.selectedModel}
                    </p>
                  </div>
                  <ChevronIcon expanded={sttExpanded} />
                </button>

                <AnimatePresence>
                  {sttExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-4 space-y-4">
                        {/* Provider Selection */}
                        <div>
                          <label className="block text-xs text-text-secondary mb-2">Anbieter</label>
                          <div className="flex gap-2">
                            {(["gemini", "openai", "mistral"] as STTProvider[]).map((provider) => (
                              <button
                                key={provider}
                                onClick={() => selectProvider(provider)}
                                className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
                                  selectedProvider === provider
                                    ? "bg-accent text-white"
                                    : "bg-white/5 text-text-secondary hover:bg-white/10"
                                }`}
                              >
                                {provider === "gemini" ? "Gemini" : provider === "openai" ? "OpenAI" : "Mistral"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* API Key for selected provider */}
                        <div>
                          <label className="block text-xs text-text-secondary mb-2">
                            {PROVIDER_NAMES[selectedProvider]} API Key
                          </label>
                          <div className="relative">
                            <input
                              type="password"
                              value={currentConfig.apiKey}
                              onChange={(e) => saveProviderApiKey(selectedProvider, e.target.value)}
                              placeholder="API Key eingeben..."
                              className={`w-full bg-white/5 rounded-xl px-4 py-3 outline-none border transition-colors text-text-primary placeholder:text-text-secondary/50 text-sm ${
                                currentConfig.apiKeyStatus === "valid"
                                  ? "border-green-500/50"
                                  : currentConfig.apiKeyStatus === "invalid"
                                  ? "border-red-500/50"
                                  : "border-transparent focus:border-accent/50"
                              }`}
                            />
                            {currentConfig.apiKeyStatus === "validating" && (
                              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                <LoadingSpinner />
                              </div>
                            )}
                            {currentConfig.apiKeyStatus === "valid" && (
                              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400">
                                <CheckIcon />
                              </div>
                            )}
                            {currentConfig.apiKeyStatus === "invalid" && (
                              <div className="absolute right-3 top-1/2 -translate-y-1/2 text-red-400">
                                <XIcon />
                              </div>
                            )}
                          </div>
                          <a
                            href={
                              selectedProvider === "gemini"
                                ? "https://aistudio.google.com/apikey"
                                : selectedProvider === "openai"
                                ? "https://platform.openai.com/api-keys"
                                : "https://console.mistral.ai/api-keys"
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-accent hover:underline mt-2 inline-block"
                          >
                            API Key erstellen
                          </a>
                        </div>

                        {/* Model Selection */}
                        {currentConfig.apiKeyStatus === "valid" && (
                          <div>
                            <label className="block text-xs text-text-secondary mb-2">
                              Modell
                              {currentConfig.isLoadingModels && (
                                <span className="ml-2 text-accent">Lade...</span>
                              )}
                            </label>
                            <div className="flex flex-wrap gap-2">
                              {currentConfig.availableModels.map((model) => (
                                <button
                                  key={model.id}
                                  onClick={() => updateProviderConfig(selectedProvider, { selectedModel: model.id })}
                                  className={`py-2 px-3 rounded-lg text-xs font-medium transition-colors ${
                                    currentConfig.selectedModel === model.id
                                      ? "bg-accent text-white"
                                      : "bg-white/5 text-text-secondary hover:bg-white/10"
                                  }`}
                                >
                                  {model.name}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Pricing Info */}
                        <div className="p-3 bg-white/5 rounded-lg text-xs text-text-secondary">
                          <p className="font-medium mb-1">Preise (ca.):</p>
                          {selectedProvider === "gemini" && <p>Gemini: Kostenlos (mit Limits)</p>}
                          {selectedProvider === "openai" && <p>Whisper: $0.006/min · GPT-4o: $0.006/min</p>}
                          {selectedProvider === "mistral" && <p>Voxtral: $0.001/min (günstigster!)</p>}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="w-full max-w-md flex-1 flex flex-col overflow-hidden"
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold">Verlauf</h2>
                {history.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Alle löschen
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="glass rounded-2xl p-8 text-center">
                  <p className="text-text-secondary text-sm">
                    Noch keine Transkripte gespeichert.
                  </p>
                  <p className="text-text-secondary/70 text-xs mt-2">
                    Transkripte werden beim Löschen automatisch im Verlauf gespeichert.
                  </p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                  {history.map((item) => (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="glass rounded-xl p-4 group"
                    >
                      <p className="text-sm text-text-primary line-clamp-3">
                        {item.text}
                      </p>
                      <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/5">
                        <span className="text-xs text-text-secondary/70">
                          {new Date(item.timestamp).toLocaleDateString("de-DE", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit"
                          })}
                        </span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => restoreFromHistory(item.text)}
                            className="text-xs text-accent hover:text-accent/80 transition-colors"
                          >
                            Wiederherstellen
                          </button>
                          <button
                            onClick={() => deleteHistoryItem(item.id)}
                            className="text-xs text-red-400 hover:text-red-300 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            Löschen
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Icons
function MicIcon({ recording }: { recording: boolean }) {
  return (
    <motion.svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      animate={recording ? { scale: [1, 1.1, 1] } : {}}
      transition={{ repeat: Infinity, duration: 1 }}
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </motion.svg>
  );
}

function LoadingIcon() {
  return (
    <motion.svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </motion.svg>
  );
}

function LoadingSpinner() {
  return (
    <motion.svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </motion.svg>
  );
}

function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? "#6366f1" : "#94a3b8"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function HistoryIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? "#6366f1" : "#94a3b8"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <motion.svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      animate={{ rotate: expanded ? 180 : 0 }}
      transition={{ duration: 0.2 }}
    >
      <path d="m6 9 6 6 6-6" />
    </motion.svg>
  );
}

export default App;
