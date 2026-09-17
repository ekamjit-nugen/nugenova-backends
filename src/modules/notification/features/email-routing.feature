Feature: Choosing which roles receive which emails
  Owners and admins pick, per email, which roles receive it, and can preview
  exactly what each email looks like. Team emails (something to review) default
  to owners and admins; personal emails default to everyone. Sign-in codes,
  security alerts and legal notices are always sent.

  Scenario: an owner sees every email with its default recipients
    Given an organization with a custom role
    When the owner opens the email notification settings
    Then every email is listed with Owner, Admin, each role and No custom role as columns
    And the daily attendance summary goes to owners and admins only

  @security
  Scenario: an employee cannot see or change email settings
    Given an organization with a custom role
    When an employee opens the email notification settings
    Then the request is forbidden

  Scenario: an owner previews an email exactly as it is sent
    Given an organization with a custom role
    When the owner previews the daily attendance summary
    Then the preview has a subject and the email body with the organization's name

  Scenario: an always-sent email cannot be switched off for a role
    Given an organization with a custom role
    When the owner tries to stop sign-in codes for members with no custom role
    Then the change is refused

  Scenario: a team email reaches a role only once it is ticked
    Given an organization with an HR role that can approve leave
    When an employee's leave request is sent out
    Then the owner is emailed but the HR member is not
    When the owner ticks the HR role for leave requests
    And another leave request is sent out
    Then the HR member is emailed too
