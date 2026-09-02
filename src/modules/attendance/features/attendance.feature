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

  Scenario: the activity feed includes manual entries and can be filtered by person and date
    Given an organization with an employee
    When the employee files a manual entry for a past day
    And the owner opens the activity feed for that date range
    Then the manual entry appears in the feed with its approval state
    And filtering the feed by a different person returns nothing

  Scenario: the daily activity view returns one consolidated row per day
    Given an organization with an employee
    When the employee files a manual entry for a past day
    And the owner opens the daily activity view for that date range
    Then there is a single row for that day with its clock-in and hours

  Scenario: a clock-in is rejected when the day already has attendance covering that time
    Given an organization with an employee
    And the employee already has a session recorded until later today
    When the employee tries to clock in now
    Then the clock-in is rejected as a conflict

  Scenario: a manual entry and a clock-in on the same day fold into one daily card
    Given an organization with an employee
    And the employee has both a manual entry and a separate record on the same past day
    When the owner opens the daily activity view for that date range
    Then that day shows as a single consolidated row

  Scenario: the owner sees the attendance setup status with the holiday gap flagged
    Given an organization with an employee
    When the owner reads the attendance setup status
    Then it reports the work schedule and flags that no holidays are configured

  @security
  Scenario: a plain employee cannot read the attendance setup status
    Given an organization with an employee
    When the employee requests the attendance setup status
    Then the request is forbidden

  Scenario: the daily roster lists every active member, not only those with a record
    Given an organization with an employee
    When the owner reads today's roster
    Then both the owner and the employee appear on it
    And the employee shows as not clocked in while the owner is not tracked

  Scenario: holidays are readable by all members but only writable by admins
    Given an organization with an employee
    When the owner adds a holiday
    Then the holiday is created
    And the employee can read the holiday
    But the employee cannot add a holiday
