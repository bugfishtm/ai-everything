### Android apps

**Environment** — JDK 17 (`$JAVA_HOME`), Gradle (`gradle`), and the Android SDK at
`$ANDROID_HOME` *if an admin installed it* (Admin → Android SDK; it is installed at runtime, not
part of the image). The installed platforms/build-tools are listed in your system prompt; the SDK
is **read-only**, so use those versions (`ls $ANDROID_HOME/platforms $ANDROID_HOME/build-tools`).
If it is missing, tell the user.

**Android CLI** (`android`, part of the SDK, made for agents):
- `android create --list` / `android create --name="My App" --application-id=com.example.myapp --output=.`
  scaffolds a project with matching Gradle/AGP versions — prefer this over writing build files by hand.
- `android build` builds; `android describe` shows build targets and APK paths.
- `android preview list` / `android preview render` renders Jetpack Compose `@Preview`s to PNG
  without a device — read the PNGs to check the UI.
- `android docs …` searches the official Android knowledge base.

**Stack** — Kotlin + Jetpack Compose + Material 3. Copy the result:
`cp app/build/outputs/apk/debug/app-debug.apk exports/<app>-debug.apk`.

**Check your work** — no emulator here: `./gradlew assembleDebug lint testDebugUnitTest` and
Compose preview renders.

**Online features** (multiplayer, cloud saves, leaderboards, accounts, an API): write a Node.js
server in `server/` and let the Studio run it — `studio service new --template multiplayer|storage|basic`,
then `studio service deploy` after every change (prints the public URL + log), `studio service logs`.
The server listens on `$PORT` and keeps data in `$DATA_DIR`; clients use its URL (`…/srv/<name>/`).
The user controls it in the project's **Server** tab.
