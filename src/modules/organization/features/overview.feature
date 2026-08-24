Feature: Organization overview
  The org overview rolls up departments, roles and people for the acting org into
  a single payload with counts, scoped to the JWT's organization.

  Scenario: overview reflects the created entities and counts
    Given an organization owner
    And they have created a department, a role, and added a member
    When they request the organization overview
    Then the overview counts show one department, one role, and two people
    And the overview lists the created department, role, and people

  @security
  Scenario: an employee-tier member cannot read the overview
    Given an employee-tier member of an organization
    When the employee requests the organization overview
    Then the overview request is rejected as forbidden
