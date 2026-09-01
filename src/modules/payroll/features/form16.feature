Feature: Form 16 (Part B)
  The employer's annual salary + tax computation for an employee, built from the
  financial year's finalized payslips and the verified declaration.

  Scenario: an employee's Form 16 aggregates the FY payslips and tax
    Given an organization with income tax enabled and an employee paid across two months
    When the employee downloads their Form 16 for the year
    Then the Form 16 shows the gross salary and TDS deducted for the year
    And the quarterly TDS adds up to the total deducted

  @security
  Scenario: an employee cannot fetch another member's Form 16
    Given an organization with income tax enabled and an employee paid across two months
    When the employee requests a Form 16 for another user id
    Then the request is forbidden
