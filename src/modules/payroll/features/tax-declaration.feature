Feature: Investment declarations
  Employees self-declare their old-regime investments for the financial year;
  payroll/HR verifies them, and the verified figures drive the employee's TDS.

  Scenario: an employee declares, HR verifies, and TDS uses the verified figures
    Given an organization with income tax on the old regime and an employee on a taxable salary
    When the employee submits an investment declaration
    And the owner verifies the declaration
    Then the declaration is verified
    And the employee's payslip TDS reflects the declared deductions

  @security
  Scenario: a plain employee cannot open the review queue
    Given an organization with income tax on the old regime and an employee on a taxable salary
    When the employee requests the review queue
    Then the request is forbidden

  Scenario: an unverified declaration does not change TDS
    Given an organization with income tax on the old regime and an employee on a taxable salary
    When the employee submits a declaration but it is not verified
    Then the employee's payslip TDS ignores the declared deductions

  Scenario: HR records a declaration for an employee and it drives TDS at once
    Given an organization with income tax on the old regime and an employee on a taxable salary
    When the owner records the employee's declaration for them
    Then the declaration is verified without a separate approval step
    And the employee's payslip TDS reflects the declared deductions
