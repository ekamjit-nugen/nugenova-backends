Feature: Unified calendar feed
  One read-only, org-scoped feed aggregates holidays, who is on leave (with
  working-from-home split out), the caller's meetings (recurrence-expanded) and
  team birthdays for a date window. Meetings are access-filtered like the
  meetings module.

  Scenario: holidays in the window appear on the calendar
    Given an organization with a member
    And a company holiday in September
    When the member reads the calendar for September
    Then the holiday appears as an all-day holiday event

  Scenario: approved leave shows the member's real name
    Given an organization with a member
    And the member has an approved casual leave in September
    When the member reads the calendar for September
    Then a leave event shows the member's name

  Scenario: working from home is its own event type
    Given an organization with a member
    And the member has an approved work-from-home day in September
    When the member reads the calendar for September
    Then a work-from-home event appears separate from leave

  @security
  Scenario: the calendar only shows meetings the caller can access
    Given an organization with a member and a stranger
    And the host schedules a September meeting inviting the member
    When the member reads the calendar for September
    Then the member sees the meeting on the calendar
    But when the stranger reads the calendar the meeting is hidden

  Scenario: a weekly meeting is expanded into several occurrences
    Given an organization with a member
    And the host schedules a weekly meeting starting in early September
    When the host reads the calendar for September
    Then the meeting appears on several days that month

  Scenario: a birthday appears from the member's date of birth
    Given an organization with a member
    And the member has a birthday in September
    When the member reads the calendar for September
    Then a birthday event appears for the member
