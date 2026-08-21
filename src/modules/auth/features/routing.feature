Feature: Post-login routing
  After OTP verification the API tells the client where to land based on the
  account's setup stage and org memberships.

  Scenario: a brand-new user with no memberships is sent to org setup
    Given a fresh email that has never logged in
    When they complete OTP verification
    Then the route is "/auth/setup-organization" with reason "new_user"

  Scenario: a platform admin is sent to the platform console
    Given a platform-admin user
    When they complete OTP verification
    Then the route is "/platform" with reason "platform_admin"

  Scenario: a completed single-org user lands on the dashboard
    Given a completed user with one active organization membership
    When they complete OTP verification
    Then the route is "/dashboard" with reason "active_user"
    And the response carries that organization id

  Scenario: a completed user with several active orgs picks one
    Given a completed user with two active organization memberships
    When they complete OTP verification
    Then the route is "/auth/select-organization" with reason "multi_org"

  @bug
  Scenario: a pending invite wins routing over an active membership
    Given a completed user with one active and one pending membership
    When they complete OTP verification
    Then the route is "/auth/accept-invite" with reason "pending_invite"
