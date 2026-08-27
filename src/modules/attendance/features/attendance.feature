Feature: Attendance — clocking, scope, and tenant isolation
  The attendance surface is strictly org-scoped. Self-service (clock in/out, my,
  stats) is open to any active member but blocked for admins/owners who manage
  rather than track. Org-wide views require owner/admin or an `attendance:view`
  custom role. A platform super admin is NOT an org member and can read no org's
  attendance, and one org can never see another's.

  Scenario: an employee clocks in and then clocks out
    Given an organization with an employee
    When the employee clocks in
    Then the clock-in succeeds with an open session
    When the employee clocks out
    Then the clock-out succeeds and worked hours are recorded

  Scenario: clocking in twice without clocking out is rejected
    Given an organization with an employee
    And the employee has clocked in
    When the employee clocks in again
    Then the request is rejected as a conflict

  Scenario: an owner cannot clock their own time
    Given an organization with an employee
    When the owner tries to clock in
    Then the request is rejected as forbidden

  Scenario: an employee's stats are scoped to themselves
    Given an organization with an employee
    When the employee requests stats
    Then the stats scope is self

  Scenario: a privileged member sees org-wide stats
    Given an organization with an employee
    When the owner requests stats
    Then the stats scope is org

  Scenario: one organization cannot see another organization's attendance
    Given two organizations each with an employee
    And the first organization's employee has clocked in
    When the second organization's owner lists attendance
    Then the first organization's record is not visible

  Scenario: the platform super admin cannot read an organization's attendance
    Given an organization with an employee
    When the platform super admin lists that organization's attendance
    Then the request is rejected as forbidden

  Scenario: a permission-scoped member with attendance:view can list attendance
    Given an organization with an attendance-viewer member
    When the attendance-viewer lists attendance
    Then the request succeeds

  Scenario: a plain employee cannot list org-wide attendance
    Given an organization with an employee
    When the employee lists attendance
    Then the request is rejected as forbidden

  Scenario: an employee cannot file a manual entry for someone else
    Given an organization with an employee
    When the employee submits a manual entry for another user id
    Then the request is rejected as forbidden

  Scenario: holidays are readable by all members but only writable by admins
    Given an organization with an employee
    When the owner adds a holiday
    Then the holiday is created
    And the employee can read the holiday
    But the employee cannot add a holiday
