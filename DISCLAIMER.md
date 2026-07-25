# Disclaimer

## No warranty

This repository is provided **"as is", without warranty of any kind**, express
or implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose, and non-infringement. See `LICENSE` for the
governing terms.

## This is a specification, not a security control

The system described here is a **code review aid**. It is not a security
control, a compliance mechanism, or a substitute for human review.

Nothing in this specification guarantees that an implementation will find any
particular defect, or any defect at all. A review that reports no findings is
evidence that a review ran and reported nothing — it is not evidence that the
change is correct, safe, or fit to ship.

Anyone deploying an implementation of this specification is responsible for
deciding what merge authority, if any, to grant it. We recommend granting none
initially.

## The measured results are narrow

The results in `RESULTS.md` were produced against a **small synthetic corpus**
— eleven blind cases across ten seeded defect classes, single-shot, in one
environment, on one day. They are reported with their limitations stated.

They do **not** establish, and should not be cited as establishing:

- performance on defect classes outside the ten seeded here;
- a real-world false-positive rate — synthetic decoys are a proxy;
- a false-negative rate, which requires production escape data no offline
  corpus contains;
- that any implementation is fit for production use.

The corpus was demonstrably imperfect: implementations under evaluation found
defects in it that its own authors had not seeded and did not know were there.
Treat the numbers as directional evidence about a specification's clarity, not
as a benchmark of code review quality.

## Model-driven systems are non-deterministic

Implementations of this specification invoke language models. Identical inputs
may produce different outputs across runs. Severity grading in particular was
observed to vary between otherwise identical runs during evaluation.

Every deterministic part of the system — routing, anchoring, publication policy,
identity — is specified to be reproducible precisely because the stochastic
parts are not. Do not assume reproducibility of anything a model produced.

## Costs are incurred by you

Running an implementation calls paid model APIs. Evaluation runs call them many
times over. The cost figures in `RESULTS.md` reflect one corpus, one set of
model choices, and the prices in effect at the time. Your costs will differ.
Set and enforce your own budget caps.

## Untrusted input

This specification describes a system that consumes **attacker-controlled
input**: diffs, file paths, change descriptions, and instruction files modified
by the change under review. Parts 1 and 7 describe a trust boundary, a sandbox,
secret detection, and prompt-injection handling.

Those are design requirements, not a completed threat model. An implementation
inherits the full risk of running language models over hostile input, and is
responsible for its own security review before being pointed at anything that
matters.

## No affiliation or endorsement

References to third-party models, providers, tools, and services are
descriptive. They do not imply endorsement by, affiliation with, or any
relationship to those parties.

## Independent judgment

Use of this specification, its harness, or any implementation derived from it is
at your own risk. Nothing here substitutes for the independent professional
judgment of the engineers responsible for the code being reviewed.
