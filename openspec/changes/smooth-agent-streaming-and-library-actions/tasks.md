## 1. Agent response latency

- [x] 1.1 Bypass the model research planner for independent default fast questions while retaining assisted planning for complex paths
- [x] 1.2 Aggregate decoded answer characters per provider delta before emitting SSE and preserve escape/final flush behavior
- [x] 1.3 Add focused backend coverage for deterministic fast planning and provider-delta answer extraction

## 2. Smooth client streaming

- [x] 2.1 Buffer follow-up answer deltas and commit them at most once per animation frame after an immediate first delta
- [x] 2.2 Flush and cancel pending animation-frame work across done, error, approval, analysis, and abort cleanup paths
- [x] 2.3 Remove the root Markdown pseudo-caret that renders as an empty block while keeping accessible generation status

## 3. Video library selected actions

- [x] 3.1 Add directly visible desktop actions for temporary removal and permanent hiding with eligible Douyin counts
- [x] 3.2 Preserve compact mobile menu copies and existing confirmation, disabled, and mixed-platform behavior
- [x] 3.3 Add responsive styling for direct and compact removal actions without changing the mobile fixed-toolbar geometry

## 4. Verification

- [x] 4.1 Run focused backend tests for the Agent streaming path
- [x] 4.2 Run the Next.js production build and inspect React/CSS changes against project best practices
- [x] 4.3 Verify the real desktop app streaming state and selected-video toolbar at desktop width
