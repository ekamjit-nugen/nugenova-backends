Feature: Timesheets
  Employees log their time and submit a weekly or monthly timesheet (per the org's
  timesheet policy); a manager approves it.

  Scenario: an employee submits a weekly timesheet and the owner approves it
    Given an organization with weekly timesheets enabled and an employee member
    When the employee submits their timesheet for the week
    And the owner approves the timesheet
    Then the employee's timesheet is approved and locked

  @security
  Scenario: a plain employee cannot open the timesheet review queue
    Given an organization with weekly timesheets enabled and an employee member
    When the employee requests the review queue
    Then the request is forbidden

  Scenario: timesheets cannot be submitted when the policy is off
    Given an organization with timesheets turned off and an employee member
    When the employee tries to submit a timesheet
    Then the submission is rejected
