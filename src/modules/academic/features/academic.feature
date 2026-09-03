Feature: Academic calendar + the personType/staffScope guard
  The academic calendar (years + ordered terms) is the education-vertical
  foundation the future gradebook anchors to. It is authored only by an org's
  owner/admin, strictly within their own org. Exactly one academic year per org
  is "current". Alongside it, the personType guard keeps students out of every
  staff-assuming surface (directory, seats) by construction.

  Scenario: an owner creates an academic year
    Given an organization
    When the owner creates an academic year "2025-26" from "2025-06-01" to "2026-05-31"
    Then the academic year is created and is not current by default

  Scenario: only one academic year can be current per org
    Given an organization with two academic years
    When the owner marks the second year as current
    Then the second year is current and the first is not

  Scenario: an employee cannot author the academic calendar
    Given an organization with an employee
    When the employee tries to create an academic year
    Then the request is rejected as forbidden

  Scenario: one org cannot see another org's academic years
    Given two organizations that each have an academic year
    When the first organization's owner lists academic years
    Then only the first organization's academic years are returned

  Scenario: terms are created in order under a year
    Given an organization with an academic year
    When the owner adds two terms to that year
    Then the terms are listed in sequence order

  Scenario: a term outside the academic year is rejected
    Given an organization with an academic year
    When the owner adds a term dated outside the academic year
    Then the request is rejected as a bad request

  Scenario: a new membership defaults to the staff person type
    Given an organization with an employee
    When the owner lists the organization members
    Then every listed member is staff

  Scenario: a student membership is excluded from the staff directory and seat count
    Given an organization with an employee and a student membership
    When the owner lists the organization members
    Then the student does not appear in the member list
    And the organization seat count excludes the student
