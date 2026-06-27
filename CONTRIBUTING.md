# Contributing

Thanks for your interest in contributing. This project is research/demo oriented — contributions should be focused on tests, security improvements, documentation, and reproducible demo steps.

How to contribute

1. Fork the repository and create a new branch for your change.
2. Add tests for any contract logic you modify (`test/` using Hardhat + Mocha/Chai).
3. Run the test suite locally: `npm test`.
4. Open a pull request with a clear description and reference to any issue.

Testing guidelines

- Use `npx hardhat test` to run Solidity tests.
- Keep tests deterministic (use fixed seeds where randomness is used in JS tests).

Code style

- Keep Solidity code compatible with 0.8.20 and follow common conventions.
- Add small, focused commits and descriptive commit messages.

Security

If you find a security vulnerability, please open a private issue and mark it as `security`, or email the maintainer directly (preferred) before disclosing publicly.
