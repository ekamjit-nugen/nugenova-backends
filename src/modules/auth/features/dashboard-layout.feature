Feature: Arranging my dashboard
  Each person can reorder and hide dashboard sections. The arrangement is saved
  to their account, so it follows them across devices, and only they can see or
  change it.

  Scenario: a user saves their dashboard arrangement
    Given a signed-in user
    When they move sales to the top and hide hiring
    Then their dashboard layout comes back in that order with hiring hidden

  Scenario: saving the dashboard keeps their other preferences
    Given a signed-in user who has set a chat holiday
    When they save a dashboard layout
    Then the chat holiday is still set

  Scenario: a malformed layout is refused
    Given a signed-in user
    When they save a layout whose order is not a list
    Then the request is rejected

  @security
  Scenario: the dashboard layout needs a signed-in user
    When someone without a token reads the dashboard layout
    Then the request is unauthorized
