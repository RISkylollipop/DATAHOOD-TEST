// ============================================================
//  config/policy.js — the one place the policy version lives
// ------------------------------------------------------------
//  When a user registers we record WHICH version of the terms and
//  privacy policy they agreed to (subscribers.consentVersion). That is
//  only meaningful if this string and the dated documents the user
//  actually saw move together. So the rule is: change the policy text,
//  bump this date, in the same commit.
//
//  Format is a plain date, not a semver, because the thing being
//  versioned is a document a human reads, and "the 8 August 2026
//  version" is how a regulator or a user would refer to it.
//
//  The frontend has its own copy of this string in the policy page
//  header (frontend/src/pages/Legal.jsx). They are asserted equal by
//  the compliance self-test rather than shared through a build step,
//  because the two apps deploy separately.
// ============================================================

export const POLICY_VERSION = '2026-08-08';

// Human-facing effective date shown at the top of the documents. Kept
// beside the version so they cannot say different things.
export const POLICY_EFFECTIVE = '8 August 2026';
