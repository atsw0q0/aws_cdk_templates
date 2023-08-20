import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as r53 from 'aws-cdk-lib/aws-route53';
import * as r53_tgt from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';


interface Context {
    [key: string]: any;
}


export interface DefaultProps extends cdk.StackProps {
    context: Context;
}


export class ThreeTierHighAvailabilityStack extends cdk.Stack {

    // constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    constructor(scope: Construct, id: string, props: DefaultProps) {
        super(scope, id, props);

        /* ---------- R53 HostZone ---------- */
        const hostzone = r53.HostedZone.fromLookup(this, `${props.context.resourceName}-r53`, {
            domainName: props.context.domainName,
        });

        /* ---------- ACM ---------- */
        const cert = new acm.Certificate(this, `${props.context.resourceName}-cert`, {
            domainName: `${props.context.subDomainName}.${props.context.domainName}`,
            validation: acm.CertificateValidation.fromDns(hostzone),
        });

        /* ---------- IAM Role ---------- */
        const roleEC2 = new iam.Role(this, `${props.context.resourceName}-role-ec2`, {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
        });
        roleEC2.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
        );
        roleEC2.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetResourcePolicy', 'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret', 'secretsmanager:ListSecretVersionIds',],
            resources: [
                'arn:aws:secretsmanager:' + cdk.Stack.of(this).region + ':' + cdk.Stack.of(this).account + ':secret:*'
            ],
        }));

        /* ---------- VPC ---------- */
        const vpc = new ec2.Vpc(this, `${props.context.resourceName}-vpc`, {
            ipAddresses: ec2.IpAddresses.cidr(props.context.vpcCidrValue),
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'ProtectedApp',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
                {
                    cidrMask: 24,
                    name: 'PrivateIsolatedDB',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
            natGateways: 2,
        });

        /* ---------- VPC Endpoint ---------- */
        vpc.addInterfaceEndpoint(`${props.context.resourceName}-edpif-ssm`, { service: ec2.InterfaceVpcEndpointAwsService.SSM, });
        vpc.addInterfaceEndpoint(`${props.context.resourceName}-edpif-ssmmessage`, { service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES, });
        vpc.addInterfaceEndpoint(`${props.context.resourceName}-edpif-ec2message`, { service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES, });
        vpc.addInterfaceEndpoint(`${props.context.resourceName}-edpif-secrets`, { service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER, });

        /* ---------- SG(ALB) ---------- */
        const sgEc2Alb = new ec2.SecurityGroup(this, `${props.context.resourceName}-sg-alb`, {
            vpc,
        });
        sgEc2Alb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

        /* ---------- SG(EC2 Web) ---------- */
        const sgEc2Web = new ec2.SecurityGroup(this, `${props.context.resourceName}-sg-ec2`, {
            vpc,
        });
        sgEc2Web.addIngressRule(ec2.Peer.ipv4(props.context.myIPAddr), ec2.Port.tcp(22));
        sgEc2Web.addIngressRule(sgEc2Alb, ec2.Port.tcp(80));

        /* ---------- SG(EFS) ---------- */
        const sgEfs = new ec2.SecurityGroup(this, `${props.context.resourceName}-sg-efs`, { vpc, });
        sgEfs.addIngressRule(sgEc2Web, ec2.Port.tcp(2049));

        /* ---------- SG(RDS) ---------- */
        const sgRds = new ec2.SecurityGroup(this, `${props.context.resourceName}-sg-rds`, {
            vpc,
        });
        sgRds.addIngressRule(sgEc2Web, ec2.Port.tcp(3306));

        /* ---------- RDS ---------- */
        const rdsInstance = new rds.DatabaseInstance(this, `${props.context.resourceName}-rds-mysql`, {
            vpc: vpc,
            engine: rds.DatabaseInstanceEngine.MARIADB,
            instanceType: new ec2.InstanceType("t3.micro"),           // db.t3.micro
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            storageType: rds.StorageType.GP3,
            multiAz: true,
            allocatedStorage: 20,
            credentials: rds.Credentials.fromGeneratedSecret(
                'mariadb',
                { secretName: `${props.context.resourceName}/rds/mariadb`, }
            ),
            securityGroups: [sgRds],
        });

        /* ---------- EFS ---------- */
        const fileSystem = new efs.FileSystem(this, `${props.context.resourceName}-efs`, {
            vpc,
            fileSystemName: 'wordpress-efs',
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroup: sgEfs
        });

        /* ---------- AutoScaling ---------- */
        const userDataEfsMount = ec2.UserData.forLinux({ shebang: '#!/bin/bash' })
        userDataEfsMount.addCommands(
            // install
            'dnf update -y',
            'dnf install -y httpd mariadb105 amazon-efs-utils nfs-utils',
            // apache
            'systemctl enable httpd && systemctl start httpd',
            'openssl rand -base64 16 > /var/www/html/index.html',
            // efs
            "file_system_id_1=" + fileSystem.fileSystemId,
            "efs_mount_point_1=/mnt/efs-mount",
            "mkdir -p \"${efs_mount_point_1}\"",
            "test -f \"/sbin/mount.efs\" && echo \"${file_system_id_1}:/ ${efs_mount_point_1} efs defaults,_netdev\" >> /etc/fstab || " +
            "echo \"${file_system_id_1}.efs." + cdk.Stack.of(this).region + ".amazonaws.com:/ ${efs_mount_point_1} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0\" >> /etc/fstab",
            "mount -a -t efs,nfs4 defaults"
        )
        const asg = new autoscaling.AutoScalingGroup(this, `${props.context.resourceName}-asg`, {
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            instanceType: new ec2.InstanceType("t3.micro"),
            machineImage: ec2.MachineImage.latestAmazonLinux2023(),
            desiredCapacity: 2,
            maxCapacity: 2,
            role: roleEC2,
            userData: userDataEfsMount,
            securityGroup: sgEc2Web,
            associatePublicIpAddress: false,
            ssmSessionPermissions: true,
        });

        /* ---------- ALB ---------- */
        const alb = new elbv2.ApplicationLoadBalancer(this, `${props.context.resourceName}-alb`, {
            vpc: vpc,
            internetFacing: true,
            securityGroup: sgEc2Alb,
        });
        /* ---------- TargetGroup ---------- */
        const tg = new elbv2.ApplicationTargetGroup(this, `${props.context.resourceName}-tg`, {
            vpc: vpc,
            port: 80,
            targetType: elbv2.TargetType.INSTANCE,
            targets: [
                asg
            ],
        });

        /* ---------- Listner ---------- */
        alb.addListener(`${props.context.resourceName}-listener-443`, {
            port: 443,
            defaultTargetGroups: [tg],
            certificates: [cert],
        });

        /* ---------- R53 Record ---------- */
        new r53.ARecord(this, `${props.context.resourceName}-r53-record`, {
            zone: hostzone,
            recordName: `${props.context.subDomainName}.${props.context.domainName}`,
            target: r53.RecordTarget.fromAlias(new r53_tgt.LoadBalancerTarget(alb)),
        })

    }
}