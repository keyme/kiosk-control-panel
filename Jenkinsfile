pipeline {
  agent {
    kubernetes {
      yaml '''

      apiVersion: v1
      kind: Pod
      name: builder
      metadata:
        labels:
          jenkins/kube-default: true
          app: jenkins
          component: agent
      spec:
        containers:
          - name: jnlp
            image: 821954540415.dkr.ecr.us-east-1.amazonaws.com/keyme/jenkins:latest
            resources:
              limits:
                cpu: 1000m
                memory: 1024Mi
              requests:
                cpu: 250m
                memory: 512Mi
            imagePullPolicy: Always
            env:
              - name: POD_IP
                valueFrom:
                  fieldRef:
                    fieldPath: status.podIP
              - name: DOCKER_HOST
                value: tcp://127.0.0.1:2376
              - name: DOCKER_TLS_CERTDIR
                value: "/certs"
              - name: DOCKER_TLS_VERIFY
                value: "1"
              - name: DOCKER_CERT_PATH
                value: "/certs/client"
              - name: "LC_ALL"
                value: "C.UTF-8"
            volumeMounts:
              - name: dind-certs
                mountPath: /certs
          - name: dind
            image: 821954540415.dkr.ecr.us-east-1.amazonaws.com/jenkins-agent/dind:27.5.1
            securityContext:
              privileged: true
            env:
              - name: DOCKER_TLS_CERTDIR
                value: "/certs"
              - name: DOCKER_CERT_PATH
                value: "/certs/client"
              - name: DOCKER_HOST
                value: tcp://0.0.0.0:2376/
              - name: "LC_ALL"
                value: "C.UTF-8"
            volumeMounts:
              - name: dind-storage
                mountPath: /var/lib/docker
              - name: dind-certs
                mountPath: /certs
            resources:
              limits:
                cpu: 4000m
                memory: 4Gi
              requests:
                cpu: 500m
                memory: 512Mi

        volumes:
          - name: dind-storage
            emptyDir: {}
          - name: dind-certs
            emptyDir: {}
      '''
    }
  }

  options {
    skipStagesAfterUnstable()
    buildDiscarder logRotator(artifactDaysToKeepStr: '5', artifactNumToKeepStr: '5', daysToKeepStr: '5', numToKeepStr: '5')
  }

  stages {

    stage('Build Staging or master') {
      when {
        anyOf {
          expression {
            return env.GIT_BRANCH == 'master'
          }
          expression {
            return env.GIT_BRANCH == 'staging'
          }
        }
      }
      steps {
        script {
          account_id = "821954540415"
          registry_repos = "kiosk-control-panel"
          base_context = "."
          path_to_dockerfile = "./cloud/Dockerfile"
          docker_build_args=""
          git_branch = scm.branches[0].name
          tag_prefix = git_branch
          git_branch_esc = sh(returnStdout: true, script: "echo \"${git_branch}\" | sed 's|/|_|g'").trim()
          build_number = currentBuild.number
          currentBuild.displayName = "#${currentBuild.number}: ${registry_repos} ${git_branch}"
        }
      }
    }

    stage('Build PR Environment') {
      when {
        anyOf {
          expression {
            return env.ghprbTargetBranch == 'master'
          }
          expression {
            return env.ghprbTargetBranch == 'staging'
          }
        }
      }
      steps {
        script {
          account_id = "821954540415"
          registry_repos = "kiosk-control-panel"
          base_context = "."
          path_to_dockerfile = "./cloud/Dockerfile"
          docker_build_args=""
          git_branch = "${env.GIT_BRANCH}"
          tag_prefix = "staging"

          branch_from_git = git_branch
          git_branch_dns = "stg-kiosk-control-panel-${ghprbPullId}"
          git_branch_esc = sh "echo "${git_branch}" | sed 's|/|_|g'"

          build_number = currentBuild.number
          intermediate_tag = new Date().getTime()
          currentBuild.displayName = "#${currentBuild.number}: ${registry_repos} pr env ${ghprbPullId}"
        }
      }
    }

    stage('Get Git SHA for Image name') {
      steps {
        script {
          sh "git rev-parse HEAD > .git/commit-id"
          git_commit_sha = readFile('.git/commit-id').trim()
        }
      }
    }

    stage('ECR Registry Login') {
      steps {
        script {
          sh """
            aws --region=us-east-1 ecr get-login-password | docker login --username AWS --password-stdin 821954540415.dkr.ecr.us-east-1.amazonaws.com
          """
        }
      }
    }

    stage('Build Container') {
      steps {
        script {
          dir(base_context) {
            sh """
              docker build --no-cache -t ${account_id}.dkr.ecr.us-east-1.amazonaws.com/keyme/${registry_repos}:${git_branch_esc}-${build_number}-${git_commit_sha} ${docker_build_args} -f ${path_to_dockerfile} .
            """
          }
        }
      }
    }

    stage('Push Container') {
      steps {
        script {
          dir(base_context) {
            sh """
              docker push ${account_id}.dkr.ecr.us-east-1.amazonaws.com/keyme/${registry_repos}:${git_branch_esc}-${build_number}-${git_commit_sha}
            """
          }
        }
      }
    }

    stage('Update App Version in Helm chart') {
      when {
        anyOf {
          expression {
            return env.GIT_BRANCH == 'master'
          }
          expression {
            return env.GIT_BRANCH == 'staging'
          }
        }
      }
      steps {
        script {
          withCredentials([sshUserPrivateKey(credentialsId: 'github-credentials', keyFileVariable: 'ID_RSA_PATH', passphraseVariable: '', usernameVariable: 'USERNAME')]) {
            sh """
              eval `ssh-agent -s`
              ssh-add ${ID_RSA_PATH}
              cd deploy/
              export GIT_SSH_COMMAND="ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no"
              git clone git@github.com:keyme/infrastructure.git
              mkdir -p infrastructure/kubernetes/\$(if [ "$git_branch_esc" = "master" ]; then echo "production"; else echo $git_branch_esc; fi)/charts/
              rsync -avI --delete $registry_repos/ infrastructure/kubernetes/\$(if [ "$git_branch_esc" = "master" ]; then echo "production"; else echo $git_branch_esc; fi)/charts/$registry_repos
              cd infrastructure/

              sed -i "s/^appVersion:.*\$/appVersion: \"$git_branch_esc-$build_number-$git_commit_sha\"/g" ./kubernetes/\$(if [ $git_branch_esc = "master" ]; then echo "production"; else echo $git_branch_esc; fi)/charts/$registry_repos/Chart.yaml
              git --no-pager diff
              git config user.name keymedev
              git config user.email keymedev@key.me
              git add .
              git commit -m "Jenkins - Argo Deploy $registry_repos $git_branch_esc"
              git push -u origin master
            """
          }
        }
      }
    }

    stage('Send Build Complete Notification') {
      steps {
        script {
          slackSend channel: '#deployments',
            color: 'good',
            message: "kiosk-control-panel ${git_branch.toUpperCase()} Build Complete!",
            teamDomain: 'keyme',
            tokenCredentialId: 'deploybot-slack-credentials',
            username: "deploybot",
            botUser: "false"
        }
      }
    }
  }
}
