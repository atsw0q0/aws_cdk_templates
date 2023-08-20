import { Environment } from 'aws-cdk-lib';

interface Context {
    [key: string]: any;
}

export interface Parameters {
    [key: string]: any;
}

// Example
export const Parameters: Parameters = {
    ownerName: 'your',
    pjName: 'pj',
    envName: 'test',
    vpcCidrValue: "10.0.0.0/16",    // CIDR
    myIPAddr: "xxx.xxx.xxx.xxx/32", // マイIP

    // Route 53
    domainName: "test.com",         // ドメイン名
    subDomainName: "www",           // サブドメイン
};
