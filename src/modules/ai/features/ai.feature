Feature: AI runtime — completions + credit metering
  Members run LLM completions through the org's configured provider. Every call
  is JWT-guarded, org-scoped, metered to the org's AI-credit ledger, and gated by
  the tier/consent policy. The acting org always comes from the token, so no org
  can spend or read another org's AI usage.

  Scenario: a completion runs through the provider, is metered, and returns tokens
    Given an organization with a member
    When the member requests a completion for "Say hi"
    Then the response carries the generated text and token counts
    And the org's AI usage balance reflects the call

  Scenario: an unauthenticated completion is rejected
    Given an organization with a member
    When an unauthenticated client requests a completion
    Then the request is rejected as unauthorized

  Scenario: an empty messages array is rejected as a bad request
    Given an organization with a member
    When the member requests a completion with no messages
    Then the request is rejected as a bad request

  Scenario: the usage endpoint returns the caller's org balance and series
    Given an organization with a member who has run a completion
    When the member reads the AI usage balance
    Then the balance is for their own organization and current period

  @security
  Scenario: one organization cannot see another organization's AI usage
    Given two organizations that have each run a completion
    When a member of the first organization reads the AI usage balance
    Then only the first organization's usage is returned

  @policy
  Scenario: the tier/consent policy can deny a call before it runs
    Given an organization whose AI policy denies calls
    When the member requests a completion
    Then the request is rejected as forbidden
    And no usage is recorded for the denied call
