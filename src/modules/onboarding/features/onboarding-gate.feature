Feature: Onboarding document security
  Requested documents are non-blocking, but the document surfaces are still
  access-controlled: only a super admin can request or approve documents, only an
  authenticated owner can open the onboarding surface, and an owner can only act
  on their own organization's documents.

  @security
  Scenario: a non super admin cannot request documents for an org
    Given a super admin has provisioned an onboarding organization
    When the owner tries to request documents for their own org
    Then the request is rejected as forbidden

  @security
  Scenario: a non super admin cannot approve a document
    Given an onboarding org with a signed, submitted document
    When the owner tries to approve that document
    Then the request is rejected as forbidden

  @security
  Scenario: an unauthenticated caller cannot open the onboarding surface
    When an anonymous caller opens the onboarding surface
    Then the request is rejected as unauthorized

  @security
  Scenario: an owner cannot submit a document belonging to another org
    Given two separate onboarding orgs each with a document requested
    When the first owner tries to submit the second org's document
    Then the request is rejected as not found
