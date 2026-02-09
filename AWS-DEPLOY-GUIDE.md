# AWS Deploy Guide - ECR + ECS Fargate + ALB

ECR URI: `096446923611.dkr.ecr.eu-central-1.amazonaws.com/moff-app`
Region:  `eu-central-1` (Frankfurt)

---

## AWS-en (sorrendben)

### 1. ECR repository - KESZ

Mar letezik: `096446923611.dkr.ecr.eu-central-1.amazonaws.com/moff-app`

### 2. IAM Execution Role

IAM > Roles > Create role
- Trusted entity: AWS service > Elastic Container Service > Elastic Container Service Task
- Policy: `AmazonECSTaskExecutionRolePolicy`
- Name: `ecsTaskExecutionRole`

### 3. ECS Cluster

ECS > Clusters > Create cluster
- Name: `moff-cluster`
- Infrastructure: AWS Fargate

### 4a. ALB Security Group

EC2 > Security Groups > Create security group
- Name: `moff-alb-sg`
- Inbound: HTTP (port 80) from 0.0.0.0/0

### 4b. ECS Task Security Group

EC2 > Security Groups > Create security group
- Name: `moff-ecs-sg`
- Inbound: Custom TCP, port 3000, Source: `moff-alb-sg`

### 5. Target Group

EC2 > Target Groups > Create target group
- Target type: IP addresses
- Name: `moff-tg`
- Protocol: HTTP, Port: 3000
- VPC: default
- Health check path: `/`
- Ne adj hozza targetet manualisan

### 6. ALB

EC2 > Load Balancers > Create > Application Load Balancer
- Name: `moff-alb`
- Scheme: Internet-facing
- Subnetek: legalabb 2 kulonbozo AZ-bol (public subnetek)
- Security group: `moff-alb-sg`
- Listener: HTTP:80 → Forward to `moff-tg`

Az ALB DNS neve a fix cimed (soha nem valtozik):
`moff-alb-661894012.eu-central-1.elb.amazonaws.com`

### 7. Task Definition

ECS > Task definitions > Create new
- Family: `moff-task`
- Launch type: Fargate
- CPU: .5 vCPU, Memory: 1 GB
- Task execution role: `ecsTaskExecutionRole`
- Container:
  - Name: `moff-app`
  - Image: `096446923611.dkr.ecr.eu-central-1.amazonaws.com/moff-app:latest`
  - Port: 3000
- Environment variables:
  ```
  DATABASE_URL=...
  CLERK_SECRET_KEY=...
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
  ```

### 8. ECS Service

ECS > moff-cluster > Create service
- Task definition: `moff-task`
- Service name: `moff-service`
- Desired tasks: 1
- Networking:
  - Public subnetek
  - Public IP: ENABLED
  - Security group: `moff-ecs-sg`
- Load balancing:
  - Type: Application Load Balancer
  - ALB: `moff-alb`
  - Listener: 80:HTTP
  - Target group: `moff-tg`
  - Container: `moff-app : 3000`

---

## GitHub-on

### Secrets

Repo > Settings > Secrets and variables > Actions:

| Secret | Ertek |
|--------|-------|
| `AWS_ACCESS_KEY_ID` | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `DATABASE_URL` | Prisma connection string |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk public key |

### Deploy

```bash
git push origin main
```

---

## Ellenorzes

1. ECR > moff-app > Images - lathato az image
2. ECS > moff-cluster > moff-service > Tasks - RUNNING
3. Bongeszobe: `http://moff-alb-XXXXXX.eu-north-1.elb.amazonaws.com`

---

## Nevek osszefoglalasa

```
AWS Region:        eu-central-1
ECR URI:           096446923611.dkr.ecr.eu-central-1.amazonaws.com/moff-app
ECS Cluster:       moff-cluster
ECS Service:       moff-service
Task Definition:   moff-task
Container Name:    moff-app
ALB:               moff-alb
Target Group:      moff-tg
ALB SG:            moff-alb-sg
ECS SG:            moff-ecs-sg
Execution Role:    ecsTaskExecutionRole
```
GitHub > Actions > Deploy to AWS > Run workflow > Run workflow
