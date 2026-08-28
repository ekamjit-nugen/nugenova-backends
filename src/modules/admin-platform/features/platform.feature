Feature: Super-admin platform usage overview
  The platform (super) admin can see cross-tenant usage — organization, user,
  member and feature-adoption counts — that no org member may access.

  Scenario: the super admin sees platform usage
    Given a platform super admin
    When they request the platform usage overview
    Then the overview reports organization, user and member totals
    And it lists per-organization usage

  Scenario: an organization owner cannot see platform usage
    Given an organization and its owner
    When the owner requests the platform usage overview
    Then the request is forbidden
