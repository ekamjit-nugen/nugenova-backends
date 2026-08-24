Feature: Organization provisioning
  A platform (super) admin names an organization and nominates an owner. The
  system creates the org, the owner user, and the owner's active membership, then
  points the owner at the org so their next login lands inside it as owner.

  Scenario: a super admin provisions an organization and its owner
    Given a signed-in super admin
    When they create an organization with a fresh owner email
    Then the organization is created with an onboarding status and a slug
    And the response names the owner account

  Scenario: the provisioned owner logs in scoped to the new org as owner
    Given a super admin has provisioned an organization for a fresh owner
    When the owner completes OTP verification
    Then the owner is routed to "/dashboard" scoped to that organization
    And an owner token can reach the org admin surface

  Scenario: a super admin can list and fetch organizations
    Given a super admin has provisioned an organization
    When the super admin lists organizations
    Then the created organization appears in the list
    And fetching it by id returns the same organization

  Scenario: fetching a missing organization returns 404
    Given a signed-in super admin
    When they fetch an organization id that does not exist
    Then the provisioning request is rejected as not found

  @security
  Scenario: a non super admin cannot provision an organization
    Given a signed-in ordinary user who is not a platform admin
    When they attempt to create an organization
    Then the provisioning request is rejected as forbidden

  @security
  Scenario: an unauthenticated caller cannot provision an organization
    When an anonymous caller attempts to create an organization
    Then the provisioning request is rejected as unauthorized
