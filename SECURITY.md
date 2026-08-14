# Security Policy

## Supported versions

The latest version published to npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/grok-loop-kit/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Calls xAI's compaction endpoint with your key and folds the result back into your loop. Transcripts pass through it and are not stored.

- **Your `XAI_API_KEY` and your transcripts** are sent to xAI's compaction endpoint over HTTPS. Nothing is written to disk and nothing goes anywhere else.
- **Compacted output is model output.** It is folded back into your loop as context. If your loop grants tools on the strength of context, treat a compacted record with the same suspicion as any other model text.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
