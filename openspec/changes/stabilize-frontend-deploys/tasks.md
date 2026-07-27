## 1. Deployment serialization

- [x] 1.1 Configure Jenkins to prevent concurrent deployments of this job
- [x] 1.2 Add a host-level deployment lock to `deploy/deploy.sh`
- [x] 1.3 Provision and preflight Jenkins permissions for the short stop/start switch

## 2. Isolated frontend release

- [x] 2.1 Copy frontend sources to a guarded staging directory and build there
- [x] 2.2 Validate staged Next.js dependencies and build artifacts before stopping production
- [x] 2.3 Switch `.next` and `node_modules` as one release with automatic rollback

## 3. Health and browser resources

- [x] 3.1 Require both backend health and the frontend settings page to pass after deployment
- [x] 3.2 Add a valid branded `/favicon.ico` resource

## 4. Verification and release

- [x] 4.1 Run Shell syntax checks, OpenSpec validation, and a local frontend production build
- [ ] 4.2 Deploy through Jenkins and verify production `/api/health`, `/settings`, and `/favicon.ico`
