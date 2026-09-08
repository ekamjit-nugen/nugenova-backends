Feature: Guardian links and the consent ledger
  A guardian membership is linked to one or more student memberships within an
  org. The link's two sides are constrained by personType (guardian↔student).
  Consent is recorded per learner + purpose, append-only: a guardian may only
  consent for a student they are linked to, revoking soft-stamps the record, and
  a purpose reads as consented only while an un-revoked record exists. All
  authoring is owner/admin, strictly within the caller's own org.

  Scenario: an admin links a guardian to a student
    Given an organization with a guardian membership and a student membership
    When the owner links the guardian to the student
    Then the link is created

  Scenario: a staff membership cannot be linked as a student
    Given an organization with a guardian membership and a staff membership
    When the owner tries to link the guardian to the staff member
    Then the request is rejected as a bad request

  Scenario: an employee cannot author guardian links
    Given an organization with an employee
    When the employee tries to link a guardian
    Then the request is rejected as forbidden

  Scenario: a guardian consents for a linked student and it can be revoked
    Given an organization with a guardian linked to a student
    When the guardian consents to ai_tier_2 for the student
    Then the purpose reads as consented for the student
    And after the owner revokes it the purpose reads as not consented

  Scenario: a guardian cannot consent for an unlinked student
    Given an organization with a guardian and an unlinked student
    When the guardian tries to consent for that student
    Then the request is rejected as a bad request
