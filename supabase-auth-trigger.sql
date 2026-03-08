-- Função para criar usuário em public.users quando um usuário é criado em auth.users
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  user_metadata JSONB;
  instituicao_id UUID;
  user_type TEXT;
  user_nome TEXT;
  user_telefone TEXT;
  user_rg TEXT;
  user_cpf TEXT;
BEGIN
  -- Extrai metadata do novo usuário
  user_metadata := NEW.raw_user_meta_data;
  
  -- Obtém os dados do metadata
  instituicao_id := (user_metadata->>'instituicaoId')::UUID;
  user_type := COALESCE(user_metadata->>'userType', 'membro');
  user_nome := COALESCE(user_metadata->>'nome', split_part(NEW.email, '@', 1));
  user_telefone := user_metadata->>'telefone';
  user_rg := user_metadata->>'rg';
  user_cpf := user_metadata->>'cpf';
  
  -- Insere o usuário na tabela public.users com o mesmo ID
  INSERT INTO public.users (id, email, nome, telefone, rg, cpf, "userType", "instituicaoId", "createdAt", "updatedAt")
  VALUES (
    NEW.id,
    NEW.email,
    user_nome,
    user_telefone,
    user_rg,
    user_cpf,
    user_type,
    instituicao_id,
    NOW(),
    NOW()
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger que executa a função quando um usuário é criado
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Função para atualizar usuário em public.users quando atualizado em auth.users
CREATE OR REPLACE FUNCTION public.handle_user_update()
RETURNS TRIGGER AS $$
DECLARE
  user_metadata JSONB;
  user_nome TEXT;
  user_telefone TEXT;
  user_rg TEXT;
  user_cpf TEXT;
BEGIN
  user_metadata := NEW.raw_user_meta_data;
  user_nome := COALESCE(user_metadata->>'nome', split_part(NEW.email, '@', 1));
  user_telefone := user_metadata->>'telefone';
  user_rg := user_metadata->>'rg';
  user_cpf := user_metadata->>'cpf';
  
  -- Atualiza o usuário na tabela public.users
  UPDATE public.users
  SET 
    email = NEW.email,
    nome = user_nome,
    telefone = user_telefone,
    rg = user_rg,
    cpf = user_cpf,
    "updatedAt" = NOW()
  WHERE id = NEW.id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger que executa a função quando um usuário é atualizado
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data)
  EXECUTE FUNCTION public.handle_user_update();

-- Função para deletar usuário em public.users quando deletado em auth.users
CREATE OR REPLACE FUNCTION public.handle_user_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM public.users WHERE id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger que executa a função quando um usuário é deletado
DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;
CREATE TRIGGER on_auth_user_deleted
  AFTER DELETE ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_user_delete();
