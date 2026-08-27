Feature: Department-scoped attendance — a manager leads only their own team

  One department holds people with different roles: a manager who leads them and
  developers who report to them. A custom role bound to a department (its token
  carries a departmentScopeId) narrows every org-wide attendance read to that
  department and refuses writes on employees outside it. Owner/admin are never
  narrowed. Self-service (clocking your own time) never needs a permission.

  Background:
    Given an organization with an "Engineering" and a "Sales" department
    And an "Engineering Manager" role scoped to Engineering granting attendance view and edit
    And an "Engineering Developer" role scoped to Engineering with no attendance permission
    And Alice is the Engineering manager
    And Bob is an Engineering developer with attendance on record
    And Dave is a Sales developer with attendance on record

  Scenario: A department-scoped manager sees only their own department
    When Alice lists attendance
    Then she sees Bob from Engineering
    And she does not see Dave from Sales

  Scenario: The owner sees every department
    When the owner lists attendance
    Then the owner sees both Bob and Dave

  Scenario: A developer cannot open the team roster
    When Bob lists attendance
    Then he is denied as forbidden

  Scenario: A developer still clocks themselves in
    When a new Engineering developer clocks in
    Then the clock-in succeeds

  Scenario: A manager cannot approve attendance outside their department
    Given Dave has a pending manual attendance entry
    When Alice approves that entry
    Then she is denied as forbidden

  Scenario: A manager approves attendance inside their department
    Given Bob has a pending manual attendance entry
    When Alice approves that entry
    Then the approval succeeds
