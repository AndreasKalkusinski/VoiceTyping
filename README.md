# Voice Typing

A modern, open-source desktop application for Speech-to-Text transcription with support for multiple AI providers.

![Version](https://img.shields.io/badge/version-0.1.6-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Multiple STT Providers**: Google Gemini, OpenAI Whisper, and Mistral AI (Voxtral)
- **Global Hotkey**: Press `Ctrl+Y` to start/stop recording from anywhere
- **System Tray**: Runs quietly in the background
- **Transcription History**: Keep track of your past transcriptions
- **Auto-start**: Optionally start with Windows
- **Privacy-first**: Your API keys are stored locally, audio is sent directly to the provider

## Supported Models

| Provider | Models |
|----------|--------|
| **Google Gemini** | Gemini 2.0 Flash, Gemini 2.5 Flash |
| **OpenAI** | Whisper, GPT-4o Transcribe, GPT-4o Mini Transcribe |
| **Mistral AI** | Voxtral Mini (3B), Voxtral Small (24B) |

## Installation

### Download

Download the latest installer from the [Releases](https://github.com/AndreasKalkusinski/VoiceTyping/releases) page:
- `Voice Typing_x.x.x_x64-setup.exe` (NSIS installer)
- `Voice Typing_x.x.x_x64_en-US.msi` (MSI installer)

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://rustup.rs/)
- [Tauri CLI](https://tauri.app/)

#### Steps

```bash
# Clone the repository
git clone https://github.com/AndreasKalkusinski/VoiceTyping.git
cd VoiceTyping

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri:build
```

## Configuration

1. Launch the app
2. Go to **Settings** (gear icon)
3. Select your preferred STT provider
4. Enter your API key:
   - **Gemini**: [Get API key](https://aistudio.google.com/apikey)
   - **OpenAI**: [Get API key](https://platform.openai.com/api-keys)
   - **Mistral**: [Get API key](https://console.mistral.ai/api-keys)
5. Choose your preferred model

## Usage

1. Click the microphone button or press `Ctrl+Y` to start recording
2. Speak into your microphone
3. Click again or press `Ctrl+Y` to stop recording
4. The transcribed text appears in the text area
5. Copy the text or continue adding more

## Pricing (approximate)

| Provider | Cost |
|----------|------|
| Google Gemini | Free (with rate limits) |
| OpenAI Whisper | $0.006/min |
| Mistral Voxtral | $0.001/min |

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Motion
- **Backend**: Tauri 2.0 (Rust)
- **Build**: Vite 7

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Related Projects

- [VoiceFlow](https://github.com/AndreasKalkusinski/VoiceFlow) - Mobile version for iOS/Android with React Native

---

Made with [Claude Code](https://claude.ai/claude-code)
