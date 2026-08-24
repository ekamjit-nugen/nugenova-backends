Feature: Custom roles
  An org owner defines custom roles carrying a fine-grained permission matrix.
  Roles are org-scoped over the shared roles table; duplicate names within an org
  are rejected and deletes are soft.

  Scenario: an owner creates a role with a permission matrix
    Given an organization owner
    When they create a role "Recruiter" that can read and write "candidates"
    Then the role is created with that permission matrix

  Scenario: an owner lists their roles
    Given an organization owner with a role named "Auditor"
    When they list roles
    Then "Auditor" is among the returned roles

  Scenario: duplicate role names in one org are rejected
    Given an organization owner with a role named "Manager+"
    When they create another role named "Manager+"
    Then the role request is rejected as a conflict

  @security
  Scenario: an employee-tier member cannot manage roles
    Given an employee-tier member of an organization
    When the employee lists roles
    Then the role request is rejected as forbidden
