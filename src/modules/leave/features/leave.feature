Feature: Leave management
  Employees apply for leave; owner/HR approve or reject. Balances are granted
  up-front per type, deducted at approval, and restored on cancel. Business-day
  counting excludes weekends and holidays. Maker-checker: you can't decide your
  own leave.

  Scenario: a member sees their leave balance seeded from the catalog
    Given an organization with an employee member
    When the employee reads their leave balance
    Then the balance lists casual, sick and earned with their default allocations

  Scenario: a member applies for casual leave
    Given an organization with an employee member
    When the employee applies for 2 days of casual leave
    Then the leave is created as pending with 2 total days

  Scenario: applying counts business days and excludes weekends
    Given an organization with an employee member
    When the employee applies for casual leave spanning a weekend
    Then only the weekdays are counted

  Scenario: overlapping leave is rejected
    Given an organization with an employee member who has a pending leave
    When the employee applies for a leave that overlaps it
    Then the second application is rejected as a conflict

  Scenario: applying for more than the balance is blocked
    Given an organization with an employee member
    When the employee applies for more casual days than they have
    Then the application is rejected as a bad request

  Scenario: approval deducts the balance
    Given an organization with an employee member who applied for 2 casual days
    When the owner approves the leave
    Then the leave is approved and 2 casual days are deducted from the balance

  Scenario: cancelling an approved leave restores the balance
    Given an organization with an employee member whose 2-day casual leave was approved
    When the employee cancels the leave
    Then the leave is cancelled and the 2 casual days are restored

  Scenario: rejecting a leave records the reason and leaves the balance untouched
    Given an organization with an employee member who applied for 2 casual days
    When the owner rejects the leave with a reason
    Then the leave is rejected and no balance is deducted

  Scenario: an owner cannot apply for leave
    Given an organization with an employee member
    When the owner tries to apply for leave
    Then the application is rejected as forbidden

  @security
  Scenario: an employee cannot approve leave
    Given an organization with an employee member who applied for 2 casual days
    When another plain employee tries to approve the leave
    Then the approval is rejected as forbidden

  Scenario: loss-of-pay ignores the balance entirely
    Given an organization with an employee member
    When the employee applies for loss-of-pay leave
    Then the leave is created without any balance check

  Scenario: owner-configured allocation drives the balance
    Given an organization with an employee member
    When the owner sets the casual leave allocation to 18
    Then the member's casual balance reflects 18 days

  Scenario: owner adds a custom leave type that members can use
    Given an organization with an employee member
    When the owner adds a custom "Study Leave" type with 10 days
    Then the member sees Study Leave among their leave types
    And the member can apply for Study Leave and it deducts from that balance on approval
