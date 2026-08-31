Feature: Payroll (simple monthly payslips)
  Owner/HR sets an employee's monthly salary, then generates monthly payslips —
  salary minus a per-day loss-of-pay deduction derived from attendance and leave.
  Employees see their own payslips. Amounts are in rupees.

  Scenario: the owner sets an employee's monthly salary
    Given an organization with an employee member
    When the owner sets the member's salary to 44000
    Then reading the member's salary returns 44000

  @security
  Scenario: an employee cannot set a salary
    Given an organization with an employee member
    When the employee tries to set their own salary
    Then the salary write is rejected as forbidden

  @security
  Scenario: an employee cannot run payroll
    Given an organization with an employee member on a salary
    When the employee tries to generate payslips
    Then the payroll run is rejected as forbidden

  Scenario: a member with no attendance is fully docked
    Given an organization with an employee member on a salary
    When the owner generates payslips for that month
    Then the member's payslip is fully loss-of-pay with zero net

  Scenario: a member on approved paid leave for the month has no loss-of-pay
    Given an organization with an employee member on a salary and paid leave all month
    When the owner generates payslips for that month
    Then the member's payslip has no loss-of-pay and full gross earnings

  Scenario: statutory deductions reduce net pay
    Given an organization with an employee member on a salary and paid leave all month
    When the owner generates payslips for that month
    Then the member's payslip deducts provident fund and professional tax and shows the employer contribution

  Scenario: the owner turns statutory deductions off through payroll policy
    Given an organization with an employee member on a salary and paid leave all month
    And the owner disables PF, ESI and professional tax
    When the owner generates payslips for that month
    Then the member's payslip has no statutory deductions and net equals gross

  Scenario: salary components drive the payslip earnings and PF wage
    Given an organization with an employee member on a component-based salary and paid leave all month
    When the owner generates payslips for that month
    Then the payslip earnings list the components and PF is computed on the Basic

  Scenario: an owner-defined custom deduction is applied to everyone
    Given an organization with an employee member on a salary and paid leave all month
    And the owner adds a custom insurance deduction of 500
    When the owner generates payslips for that month
    Then the member's payslip includes the custom deduction and it reduces net pay

  Scenario: a per-employee recurring deduction is recovered from that employee only
    Given an organization with an employee member on a salary with a 2000 loan recovery and paid leave all month
    When the owner generates payslips for that month
    Then the member's payslip deducts the 2000 loan recovery

  @security
  Scenario: a member cannot read another member's payslip
    Given an organization with two members who both have payslips
    When one member requests the other's payslip
    Then the payslip read is rejected as forbidden
