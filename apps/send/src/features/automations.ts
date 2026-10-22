/** Registers the automation run engine with the worker. */
import { extraHandlers } from '../worker/runner.js';
import { runAutomationStep, type StepJob } from '../services/automations.js';

extraHandlers.automation_step = async (ctx, job) => runAutomationStep(ctx, job.payload as unknown as StepJob);
