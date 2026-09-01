Feature: Governed payroll run (lifecycle + maker-checker)
  Payroll is run as a governed unit: open a run → process (draft payslips) → approve
  → finalize (payslips publish to employees). Drafts stay hidden until the run is
  finalized. Only payroll managers can drive a run.

  Scenario: a run goes from draft through to finalized and publishes payslips
    Given an organization with an employee member on a salary
    When the owner opens and processes a payroll run
    Then the run is in review with one employee and the member sees no payslip yet
    When the owner approves and finalizes the run
    Then the run is finalized and the member now sees their published payslip

  Scenario: a run cannot be finalized before it is approved
    Given an organization with an employee member on a salary
    When the owner opens and processes a payroll run
    Then finalizing the run before approval is rejected

  @security
  Scenario: an employee cannot drive a payroll run
    Given an organization with an employee member on a salary and a processed run
    When the employee tries to approve the run
    Then the run action is rejected as forbidden
