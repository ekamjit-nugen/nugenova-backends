Feature: Statutory registers & returns
  Finance downloads filing-ready registers for a finalized month, computed from
  the immutable payslips.

  Scenario: owner downloads registers for a finalized month
    Given an organization that has finalized payroll with statutory deductions
    When the owner downloads the payroll register
    Then the register lists the employee with gross, PF and net columns
    And the PF register splits the employer contribution into EPS and EPF

  Scenario: owner downloads the bank payout file
    Given an organization that has finalized payroll with statutory deductions
    When the owner downloads the bank payout file
    Then the payout lists the employee's account, IFSC and net pay

  @security
  Scenario: a plain employee cannot download returns
    Given an organization that has finalized payroll with statutory deductions
    When a plain employee requests the payroll register
    Then the request is forbidden
