Feature: Work-from-home is a request → approval flow
  WFH is no longer self-declared at clock-in. An employee raises a WFH request
  for a date range; an owner/HR reviews it; and only an APPROVED day lets a
  normal clock-in count as work-from-home (skipping the office geo-fence).

  Background:
    Given an organization with an office geo-fence policy and an employee

  Scenario: an employee raises a WFH request that starts pending
    When the employee requests work-from-home for today
    Then the request is created with status pending
    And it appears in the employee's WFH requests

  Scenario: an owner approves a WFH request
    Given the employee has a pending WFH request for today
    When the owner approves the request
    Then the request status is approved
    And the request appears in the pending queue before approval but not after

  Scenario: an approved WFH day lets the employee clock in from anywhere
    Given the employee has an approved WFH request for today
    When the employee clocks in from outside the office
    Then the clock-in succeeds and is recorded as work-from-home

  Scenario: without approval an office clock-in is still geo-fenced
    When the employee clocks in from outside the office with no WFH approval
    Then the clock-in is rejected

  Scenario: an owner rejects a WFH request
    Given the employee has a pending WFH request for today
    When the owner rejects the request
    Then the request status is rejected
    And a clock-in from outside the office is rejected

  Scenario: an employee cancels a pending WFH request
    Given the employee has a pending WFH request for today
    When the employee cancels the request
    Then the request no longer appears in their WFH requests

  Scenario: a WFH request for past dates is refused
    When the employee requests work-from-home for yesterday
    Then the WFH request is rejected as a bad request

  @security
  Scenario: an employee cannot review WFH requests
    Given the employee has a pending WFH request for today
    When the employee tries to approve their own request
    Then the review is rejected as forbidden
