Feature: A shift that crosses midnight can be clocked out of
  A 16:30–01:30 shift is opened on one calendar day and closed on the next, so
  a clock-out anchored to "today" never finds the session that is still running.
  It told the employee to clock in first; they did, which stranded the real
  session and opened a seconds-long phantom day beside it whose clock-in and
  clock-out were the same moment. The night shift is identified from the policy.

  A day shift is deliberately left alone: there, an open session from yesterday
  is a forgotten checkout, and closing it at today's time would bank a ~24h day.

  Background:
    Given an organization with an employee on a 16:30 to 01:30 night shift

  Scenario: clocking out after midnight closes last night's session
    Given the employee has been clocked in since last night
    When the employee clocks out
    Then last night's record is closed
    And no second record was created for today

  Scenario: the phantom day is refused rather than created
    Given the employee has been clocked in since last night
    When the employee clocks in again
    Then they are told they are still clocked in from their last shift

  Scenario: mid-shift the employee is shown as clocked in, not clocked out
    Given the employee has been clocked in since last night
    When the employee checks today's status
    Then they are shown as clocked in on a session carried over from yesterday

  Scenario: a session left open for days is not claimable by a clock-out
    Given the employee has a session left open since well before yesterday
    When the employee clocks out
    Then the clock-out is refused

  Scenario: a day shift still treats yesterday's open session as a missed checkout
    Given the employee is moved to a 09:00 to 18:00 day shift
    And the employee has been clocked in since last night
    When the employee clocks out
    Then the clock-out is refused
