Feature: Departments
  An org owner sets up departments for their organization. Every route is scoped
  to the org the JWT carries — never an org id from the client — so a token can
  only ever touch its own org's departments. Deletes are soft.

  Scenario: an owner creates a department
    Given an organization owner
    When they create a department named "Engineering"
    Then the department is created under their organization

  Scenario: an owner lists their departments
    Given an organization owner with a department named "Sales"
    When they list departments
    Then "Sales" is among the returned departments

  Scenario: an owner updates a department
    Given an organization owner with a department named "Support"
    When they rename it to "Customer Support"
    Then the department reads back as "Customer Support"

  Scenario: an owner soft-deletes a department
    Given an organization owner with a department named "Legacy"
    When they delete that department
    Then it no longer appears in the department list

  Scenario: duplicate department names in one org are rejected
    Given an organization owner with a department named "Finance"
    When they create another department named "Finance"
    Then the department request is rejected as a conflict

  @security
  Scenario: an employee-tier member cannot manage departments
    Given an employee-tier member of an organization
    When the employee lists departments
    Then the department request is rejected as forbidden

  @security
  Scenario: an owner cannot see another organization's departments
    Given two organizations each owned by a different owner
    And organization B has a department named "Secret-B"
    When organization A's owner lists departments
    Then organization B's department is not visible
