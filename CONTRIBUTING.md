# Contributing to PiMobile

Thanks for your interest! PiMobile is a native Android + TypeScript stack — Kotlin/Compose on the phone, TypeScript/WS on the server. Contributions of any size are welcome.

## Getting started

1. Fork the repo and clone it.
2. Install dependencies:
   - Server: `cd server && npm install`
   - Android: open `android/` in Android Studio Ladybug 2024.2+ and let Gradle sync (or `cd android && ./gradlew assembleDebug`)
3. Run the server: `cd server && npm run dev` (or `npm start`)
4. Build the app: `cd android && ./gradlew assembleDebug` (APK at `android/app/build/outputs/apk/debug/`)
5. Connect: set `YOUR_LAN_IP:8787` in App → Settings → Server Address.

## What to work on

- Check [ROADMAP.md](ROADMAP.md) for planned features, or [open an issue](https://github.com/) describing what you'd like to build first — a one-liner is enough.
- Simple fixes (typos, docs, small bugs) are always welcome without prior discussion.

## Development workflow

- Keep the protocol in sync: WebSocket message shapes are defined in `server/src/protocol.ts` and `android/app/src/main/java/com/pimobile/app/data/PiProtocol.kt`. If you change one, update the other and the parser `PiMessageParser.kt` together.
- Server: run typecheck + lint + tests before PR:
  ```bash
  cd server
  npm run typecheck   # tsc --noEmit, must be 0 errors
  npm run lint        # eslint, must be 0 issues
  TEST_HOST=127.0.0.1 npm run test:integration  # 7 suites, 570+ assertions
  ```
- Android: run unit tests before PR:
  ```bash
  cd android
  ./gradlew testDebugUnitTest  # 26 tests (PiMessageParser + PiRepository)
  ```
- Follow existing code style (the repo mixes Chinese and English comments — new code may use either, but keep it consistent within a file).

## PR checklist

- [ ] Changes are tested (server integration suite and/or `testDebugUnitTest`)
- [ ] Protocol changes are documented in `server/src/protocol.ts` + `android/.../PiProtocol.kt` + `docs/ARCHITECTURE.md`
- [ ] Commit messages are concise and describe the *why* (e.g. `fix: lazy file-card recovery on cold restart`)

## Reporting bugs

Please include:

- PiMobile version / commit
- Pi version (`pi --version`) and `@earendil-works/pi-coding-agent` version
- Server OS + Android device / emulator + OS version
- Server startup log excerpt (watch for `OPEN ACCESS` warning)
- Steps to reproduce

## Code of conduct

Be kind. Assume good intent. This is a hobby-scale project — reviewers are volunteering their time.
