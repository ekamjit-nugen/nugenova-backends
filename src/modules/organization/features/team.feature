Feature: Team membership
  An org owner adds people to their organization, assigning an enforced tier, an
  optional custom role, and a department. The member list always includes the
  owner. Everything is scoped to the org the JWT carries.

  Scenario: an owner adds a member with a role and department
    Given an organization owner with a department named "Engineering"
    When they add a member with the "manager" role in that department
    Then the member is created active with that role and department
    And the new member appears in the team list

  Scenario: an owner adds a member by a custom role, deriving the tier
    Given an organization owner who has seeded the default roles
    When they add a member with the "HR Manager" custom role
    Then the member carries that custom role and the derived "manager" tier

  Scenario: the owner is included in the team list
    Given an organization owner
    When they list team members
    Then the owner's own membership is in the list

  Scenario: adding the same person twice is rejected
    Given an organization owner who has added a member
    When they add the same email again
    Then the member request is rejected as a conflict

  @security
  Scenario: an employee-tier member cannot add teammates
    Given an employee-tier member of an organization
    When the employee tries to add a member
    Then the member request is rejected as forbidden

  @security
  Scenario: an owner cannot see another organization's members
    Given two organizations each owned by a different owner
    And organization B's owner has added a member
    When organization A's owner lists team members
    Then organization B's member is not visible
