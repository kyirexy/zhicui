// 知萃 CI/CD：Git push → Jenkins → deploy.sh
pipeline {
    agent any

    parameters {
        choice(
            name: 'AGENT_RELEASE_MODE',
            choices: ['dark', 'stable'],
            description: 'Agent 发布阶段。首次开放及每个待晋级提交先选 dark，证据通过后对同一提交选 stable。'
        )
    }

    options {
        timeout(time: 20, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
        // 同一任务的后续构建排队，避免两次发布同时操作生产目录。
        disableConcurrentBuilds()
    }

    stages {
        stage('拉取代码') {
            steps {
                checkout scm
                sh 'git rev-parse --short HEAD'
            }
        }

        stage('部署到服务器') {
            steps {
                script {
                    if (!(params.AGENT_RELEASE_MODE in ['dark', 'stable'])) {
                        error('AGENT_RELEASE_MODE 只能是 dark 或 stable')
                    }
                    currentBuild.description = "Agent ${params.AGENT_RELEASE_MODE}"
                }
                withCredentials([
                    string(
                        credentialsId: 'zhicui-production-smoke-email',
                        variable: 'SMOKE_LOGIN_EMAIL'
                    ),
                    file(
                        credentialsId: 'zhicui-production-smoke-password-file',
                        variable: 'SMOKE_PASSWORD_FILE'
                    )
                ]) {
                    withEnv([
                        "AGENT_RELEASE_MODE=${params.AGENT_RELEASE_MODE}",
                        "SMOKE_REQUIRE_AGENT_INTERFACE=${params.AGENT_RELEASE_MODE == 'stable' ? '1' : '0'}"
                    ]) {
                        // 只在 shell 运行时展开 Credentials Binding 变量，避免秘密进入 Groovy 字符串。
                        sh label: "Agent ${params.AGENT_RELEASE_MODE} 发布", script: '''
                            set -eu
                            test "$AGENT_RELEASE_MODE" = dark || test "$AGENT_RELEASE_MODE" = stable
                            test -n "$SMOKE_LOGIN_EMAIL"
                            test -r "$SMOKE_PASSWORD_FILE"
                            test -s "$SMOKE_PASSWORD_FILE"
                            test -n "$WORKSPACE"
                            test -f "$WORKSPACE/deploy/deploy.sh"
                            AGENT_RELEASE_MODE="$AGENT_RELEASE_MODE" \
                            SMOKE_REQUIRE_AGENT_INTERFACE="$SMOKE_REQUIRE_AGENT_INTERFACE" \
                            SMOKE_LOGIN_EMAIL="$SMOKE_LOGIN_EMAIL" \
                            SMOKE_PASSWORD_FILE="$SMOKE_PASSWORD_FILE" \
                              bash "$WORKSPACE/deploy/deploy.sh"
                        '''
                    }
                }
            }
        }
    }

    post {
        success { echo '✅ CI/CD 部署成功' }
        failure { echo '❌ CI/CD 部署失败，请查看日志排查' }
    }
}
