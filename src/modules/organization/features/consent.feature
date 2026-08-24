Feature: Terms & Conditions consent gate
  A newly provisioned organization must accept the platform Terms & Conditions
  before its owner can use the app. Editing the terms bumps the version and forces
  every organization to re-accept. A super admin can halt an organization, fully
  blocking it until it is reactivated. Requested documents never block access.

  Scenario: the owner of a new organization is routed to consent
    Given a super admin has provisioned an organization for a fresh owner
    When the owner completes OTP verification
    Then the owner is routed to "/consent"

  Scenario: an unconsented owner is blocked from the org-admin surface
    Given a super admin has provisioned an organization for a fresh owner
    When the unconsented owner calls the departments endpoint
    Then the request is rejected as forbidden

  Scenario: accepting the terms unlocks the app
    Given a super admin has provisioned an organization for a fresh owner
    When the owner accepts the Terms and Conditions
    Then the owner can reach the departments endpoint
    And logging in again routes the owner to "/dashboard"

  Scenario: the consent screen returns the current terms
    Given a super admin has provisioned an organization for a fresh owner
    When the owner opens the consent screen
    Then it returns the current terms text and version
    And it reports consent as not yet accepted

  Scenario: the editor offers multiple terms templates
    Given a super admin has provisioned an organization for a fresh owner
    When the super admin lists the terms templates
    Then more than one template is returned

  Scenario: publishing a PDF makes the org read and accept the document
    Given an organization that has accepted the current terms
    When the super admin publishes a PDF as the new terms
    Then the consent screen reports a PDF document to read
    And the owner can download the current terms PDF
    And after re-accepting, the owner can reach the departments endpoint

  Scenario: editing the terms forces the org to re-accept
    Given an organization that has accepted the current terms
    When the super admin publishes a new version of the terms
    Then the owner is blocked from the departments endpoint until they re-accept

  Scenario: a super admin halts an organization
    Given an organization that has accepted the current terms
    When the super admin halts the organization
    Then the owner is routed to "/suspended"
    And the halted owner is blocked from the departments endpoint

  Scenario: a super admin reactivates a halted organization
    Given a halted organization
    When the super admin reactivates it
    Then the owner can reach the departments endpoint again

  @security
  Scenario: a non super admin cannot edit the terms
    Given a super admin has provisioned an organization for a fresh owner
    When the owner tries to publish new terms
    Then the request is rejected as forbidden

  @security
  Scenario: a non super admin cannot halt an organization
    Given a super admin has provisioned an organization for a fresh owner
    When the owner tries to halt their own organization
    Then the request is rejected as forbidden
