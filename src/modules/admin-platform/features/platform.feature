Feature: Super-admin platform usage overview
  The platform (super) admin sees cross-tenant ACCOUNT, security and infrastructure
  signals — organizations, seats, auth posture, mail/notification throughput — that
  no org member may access. It must NOT expose tenant business data (payroll, leave,
  policies, attendance, onboarding); those stay private to each organization.

  Scenario: the super admin sees platform usage
    Given a platform super admin
    When they request the platform usage overview
    Then the overview reports account, security and infrastructure signals
    And it exposes no tenant business data
    And it lists per-organization usage

  Scenario: an organization owner cannot see platform usage
    Given an organization and its owner
    When the owner requests the platform usage overview
    Then the request is forbidden
