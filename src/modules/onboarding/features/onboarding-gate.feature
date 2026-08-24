Feature: Onboarding access gate
  Until every requested document is approved an organization stays in onboarding:
  its owner can sign in only to the document-submission surface and is kept out of
  the rest of the app. Once approved, the organization goes live.

  Scenario: the owner of an onboarding org is routed to onboarding
    Given a super admin has provisioned an onboarding organization
    When the owner completes OTP verification
    Then the owner is routed to "/onboarding"

  Scenario: the owner cannot reach the org-admin surface while onboarding
    Given a super admin has provisioned an onboarding organization
    When the onboarding owner calls the departments endpoint
    Then the request is rejected as forbidden

  Scenario: once every document is approved the owner reaches the dashboard
    Given an onboarding org whose only document has been approved
    When the owner completes OTP verification again
    Then the owner is routed to "/dashboard"
    And the owner can now reach the departments endpoint

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
