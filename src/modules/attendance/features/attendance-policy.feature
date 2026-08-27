Feature: Attendance is governed by the org's policy
  Attendance sits behind Policy. A work-timing policy defines the employee's
  clock-in/out window, so the "late" line, the WFH rules, and the office
  geo-fence all come from the applicable policy — never a hardcoded default.
  The most specific applicable policy wins (specific ▸ department ▸ all).

  Background:
    Given an organization with an employee in the "Engineering" department

  Scenario: a clock-in is judged against the org work-timing policy
    Given the org work-timing policy starts at "09:00" with a 15 minute grace
    When the employee clocks in 40 minutes after the start time
    Then the record is marked late

  Scenario: the policy — not a fixed default — decides what counts as late
    Given the org work-timing policy starts at "12:00" with a 15 minute grace
    When the employee clocks in at "09:30" local time
    Then the record is marked present

  Scenario: a department policy overrides the org-wide default
    Given the org-wide policy starts at "09:00"
    And an Engineering department policy starts at "11:00"
    When the Engineering employee clocks in at "10:30" local time
    Then the record is marked present

  Scenario: WFH is rejected on a day the policy does not allow
    Given a WFH policy allowing only "monday" applies to the employee
    When the employee declares WFH and clocks in on a "tuesday"
    Then the clock-in is rejected

  Scenario: WFH is rejected once the monthly cap is reached
    Given a WFH policy with a monthly cap of 1 applies to the employee
    And the employee has already worked from home once this month
    When the employee declares WFH and clocks in again this month
    Then the clock-in is rejected

  Scenario: an office geo-fence blocks a clock-in outside the radius
    Given an office policy with a geo-fence around the office applies to the employee
    When the employee clocks in from outside the radius
    Then the clock-in is rejected

  Scenario: an office geo-fence allows a clock-in inside the radius
    Given an office policy with a geo-fence around the office applies to the employee
    When the employee clocks in from inside the radius
    Then the clock-in succeeds

  Scenario: a WFH-declared clock-in is not geo-fenced
    Given an office policy with a geo-fence around the office applies to the employee
    And WFH is allowed for the employee today
    When the employee declares WFH and clocks in from anywhere
    Then the clock-in succeeds
