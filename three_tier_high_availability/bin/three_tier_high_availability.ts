#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';

import { ThreeTierHighAvailabilityStack } from '../lib/three_tier_high_availability-stack';

import { Parameters } from '../parameter';

const params = Parameters;
params[`resourceName`] = `${params.pjName}-${params.envName}`;

const app = new cdk.App();
new ThreeTierHighAvailabilityStack(app, 'ThreeTierHighAvailability', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    context: params,
});

app.synth()