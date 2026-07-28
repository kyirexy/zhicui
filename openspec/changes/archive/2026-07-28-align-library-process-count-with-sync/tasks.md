## 1. Processing defaults

- [x] 1.1 Change the fresh-page automatic processing count from 20 to 50
- [x] 1.2 Make sync presets and custom sync input derive a capped default processing count
- [x] 1.3 Enforce the same 50-item cap in the processing input and synchronization submission path

## 2. Verification and local handoff

- [x] 2.1 Validate the OpenSpec change and build the frontend
- [x] 2.2 Run the existing parallel extraction verification to confirm batch concurrency and no-media persistence
- [x] 2.3 Restart the local frontend on port 3003 and smoke-test the library route
