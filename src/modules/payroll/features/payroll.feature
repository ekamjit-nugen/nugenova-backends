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

  Scenario: a member on approved paid leave for the month is paid in full
    Given an organization with an employee member on a salary and paid leave all month
    When the owner generates payslips for that month
    Then the member's payslip has no loss-of-pay and the full net salary

  @security
  Scenario: a member cannot read another member's payslip
    Given an organization with two members who both have payslips
    When one member requests the other's payslip
    Then the payslip read is rejected as forbidden
