Feature: Attendance automation (crons)
  Scheduled jobs keep attendance honest: employees with no record on a past
  working day are marked absent (unless on approved leave/WFH), forgotten
  sessions are auto-closed, and yesterday's exceptions are summarised to admins.

  Scenario: an employee with no record on a past working day is marked absent
    Given an organization with a tracked employee who joined long ago
    When the absentee job runs for the day after a past working day
    Then that employee has an absent record for that day
    And the employee is notified that they were marked absent

  Scenario: an employee on approved leave is not marked absent
    Given an organization with a tracked employee who joined long ago
    And the employee has approved leave covering that working day
    When the absentee job runs for the day after that working day
    Then that employee has no attendance record for that day

  Scenario: a session left open past the day is auto-closed
    Given an organization with a tracked employee who joined long ago
    And the employee has a clock-in with no clock-out from two days ago
    When the missed-checkout reconcile job runs
    Then the session is closed as a missed checkout with computed hours

  Scenario: yesterday's exceptions are summarised to admins
    Given an organization with a tracked employee who joined long ago
    And that employee was marked absent for the previous working day
    When the daily digest job runs
    Then a digest is sent for that organization
