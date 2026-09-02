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

  Scenario: the owner filters team timesheets by month and employee
    Given an organization with weekly timesheets enabled and an employee member
    When the employee submits their timesheet for the week
    Then filtering the review by that month returns the timesheet
    And filtering by a different month returns nothing
    And filtering by that employee returns the timesheet

  Scenario: the owner opens a timesheet's full day-by-day detail
    Given an organization with weekly timesheets enabled and an employee member
    When the employee submits their timesheet for the week
    Then the owner can open the timesheet detail and see its day entries
