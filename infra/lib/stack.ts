import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_appsync as appsync,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const here = dirname(fileURLToPath(import.meta.url));

export interface PlaymatStackProps extends StackProps {
  jwtKey: string;
}

export class PlaymatStack extends Stack {
  constructor(scope: Construct, id: string, props: PlaymatStackProps) {
    super(scope, id, props);

    // ---------------- DynamoDB ----------------

    const roomsTable = new dynamodb.Table(this, 'Rooms', {
      partitionKey: { name: 'roomCode', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expireAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const boardTable = new dynamodb.Table(this, 'Board', {
      partitionKey: { name: 'roomCode', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expireAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------- Lambda authorizer ----------------

    const authorizerFn = new nodejs.NodejsFunction(this, 'Authorizer', {
      entry: join(here, '..', 'lambda', 'authorizer.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: { JWT_KEY: props.jwtKey },
      bundling: {
        minify: true,
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        // CJS deps require() Node builtins inside the ESM bundle.
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    // ---------------- Events API ----------------

    const lambdaProvider: appsync.AppSyncAuthProvider = {
      authorizationType: appsync.AppSyncAuthorizationType.LAMBDA,
      lambdaAuthorizerConfig: {
        handler: authorizerFn,
        resultsCacheTtl: Duration.minutes(5),
      },
    };
    const iamProvider: appsync.AppSyncAuthProvider = {
      authorizationType: appsync.AppSyncAuthorizationType.IAM,
    };

    const api = new appsync.EventApi(this, 'Events', {
      apiName: 'playmat-events',
      logConfig: { fieldLogLevel: appsync.AppSyncFieldLogLevel.ALL },
      authorizationConfig: {
        authProviders: [lambdaProvider, iamProvider],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
        defaultPublishAuthModeTypes: [
          appsync.AppSyncAuthorizationType.LAMBDA,
          appsync.AppSyncAuthorizationType.IAM,
        ],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.LAMBDA],
      },
    });

    const boardDs = api.addDynamoDbDataSource('BoardDs', boardTable);

    const stateCode = readFileSync(join(here, '..', 'handlers', 'state.js'), 'utf8').replaceAll(
      '__BOARD_TABLE__',
      boardTable.tableName
    );
    api.addChannelNamespace('state', {
      code: appsync.Code.fromInline(stateCode),
      publishHandlerConfig: { dataSource: boardDs },
    });

    const ephemeralCode = readFileSync(join(here, '..', 'handlers', 'ephemeral.js'), 'utf8');
    api.addChannelNamespace('ephemeral', {
      code: appsync.Code.fromInline(ephemeralCode),
    });

    // ---------------- Room Lambda (Function URL) ----------------

    const roomFn = new nodejs.NodejsFunction(this, 'Room', {
      entry: join(here, '..', 'lambda', 'room.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: {
        JWT_KEY: props.jwtKey,
        ROOMS_TABLE: roomsTable.tableName,
        BOARD_TABLE: boardTable.tableName,
        EVENTS_HTTP_HOST: api.httpDns,
      },
      bundling: {
        minify: true,
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });
    roomsTable.grantReadWriteData(roomFn);
    boardTable.grantReadWriteData(roomFn);
    api.grantPublish(roomFn);

    const roomUrl = roomFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST, lambda.HttpMethod.PUT],
        allowedHeaders: ['Content-Type', 'Authorization'],
        maxAge: Duration.hours(1),
      },
    });

    // ---------------- Web hosting: S3 + CloudFront ----------------

    const webBucket = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'playmat web',
    });

    // ---------------- Outputs (consumed by scripts/deploy.mjs) ----------------

    new CfnOutput(this, 'ApiBase', { value: roomUrl.url.replace(/\/$/, '') });
    new CfnOutput(this, 'EventsHttpHost', { value: api.httpDns });
    new CfnOutput(this, 'EventsRealtime', { value: `wss://${api.realtimeDns}/event/realtime` });
    new CfnOutput(this, 'WebBucket', { value: webBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'WebUrl', { value: `https://${distribution.distributionDomainName}` });
  }
}
