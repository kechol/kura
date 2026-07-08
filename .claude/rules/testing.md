---
description: Test-suite invariants — never touch the real ~/.kura, use in-memory / temp-dir DBs, mock the LLM provider (never a live server), gate the real vaporetto download behind KURA_TEST_DOWNLOAD, and keep CJK fixtures Japanese.
paths:
  - "tests/**/*.ts"
---

# Testing rules

The full policy is `.claude/docs/testing.md`; these are the load-bearing
rules a test must not break.

## R1. Never point a test at the real `~/.kura`

Tests use an in-memory database (`KURA_DB=:memory:`) or a temp directory
(`KURA_HOME` / `KURA_DB` set to a `mktemp`-style path). A test that reads
or writes the user's real `~/.kura/kura.db` can corrupt their knowledge
base and is non-deterministic. There is no exception.

## R2. LLM features are tested against a mock provider

LLM-dependent tests inject a mock `LLMProvider` via `setProviderForTests`
— never a live Ollama / LM Studio server. Two reasons: CI has no provider,
and a live model is non-deterministic. Every LLM feature also has a
**no-provider / degraded** test path (per `invariants.md` R4); a feature
whose degraded behavior is untested is under-tested.

## R3. The real vaporetto download is opt-in

The integration test that actually downloads sqlite-vaporetto, verifies
its SHA256, `dlopen`s it, and tokenizes Japanese runs only when
`KURA_TEST_DOWNLOAD=1` (CI sets it on linux-x64). The default `bun test`
must pass offline; don't add unconditional network access to the suite.

## R4. CJK fixtures stay Japanese

Fixture documents, queries, titles, tags, and assertions under `tests/`
are Japanese on purpose — they exercise the vaporetto morphological
tokenizer, BM25 ranking on CJK text, snippet windows, and chunking.
Do not translate them to English "for readability"; that removes the
regression they exist to catch (`terminology.md` R3).

## R5. Assert behavior through core / CLI, not raw SQL

Prefer exercising a repository function or a CLI command and asserting on
its result over hand-writing SQL against the fixture DB. Raw-SQL
assertions bypass the repository sync (`invariants.md` R1) and pass even
when the derived tables are inconsistent — which is exactly the class of
bug the suite should catch.
