## 1. Desktop runtime shell

- [x] 1.1 Add synchronous and React desktop-runtime detection without affecting ordinary Web or Android
- [x] 1.2 Build the desktop navigation rail, context bar, account controls and active-route states
- [x] 1.3 Integrate the desktop shell into the root layout and hide Web-only chrome in Electron

## 2. Desktop workspace home

- [x] 2.1 Build a desktop-only root workspace using existing library, note and plan APIs
- [x] 2.2 Add independent loading, partial-error and empty states with direct actions
- [x] 2.3 Preserve the current marketing homepage for non-desktop runtimes

## 3. Core page visual system

- [x] 3.1 Add scoped desktop tokens and canvas/surface/typography rules without new gradients
- [x] 3.2 Align video library, knowledge library, plans and settings to the desktop workspace
- [x] 3.3 Add visible focus, active, hover and reduced-motion states within the 200ms interaction limit
- [x] 3.4 Replace the dashboard card grid with an editorial video queue, focused plan list and knowledge rows
- [x] 3.5 Adopt lighter Phosphor icons and remove repeated side-stripe accents from desktop task surfaces

## 4. Verification and packaging

- [x] 4.1 Validate the OpenSpec change and run the Next.js production build
- [x] 4.2 Verify ordinary Web and common mobile widths remain unchanged
- [x] 4.3 Verify all core routes in the real Electron development window at minimum and normal desktop sizes
- [x] 4.4 Increment the Windows desktop version and build the redesigned installer
